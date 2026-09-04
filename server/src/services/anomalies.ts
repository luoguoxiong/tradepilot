import { db, getSetting } from '../db.js';

export type AnomalyType = 'due_soon' | 'overdue' | 'deposit_pending' | 'stalled';

export interface ReminderRules {
  /** 交期前 N 天各生成一条提醒（级别由天数决定） */
  days_before: number[];
  /** 创建超过 N 天仍未确认定金 → 提醒 */
  deposit_days: number;
  /** 最近进度事件距今超过 N 天 → 停滞提醒 */
  stalled_days: number;
}

export const DEFAULT_RULES: ReminderRules = { days_before: [7, 3, 1], deposit_days: 7, stalled_days: 14 };

export function getRules(): ReminderRules {
  const saved = getSetting<Partial<ReminderRules>>('reminder_rules');
  return { ...DEFAULT_RULES, ...(saved || {}) };
}

export interface Anomaly {
  type: AnomalyType;
  level: 'high' | 'medium' | 'low';
  order_id: number;
  order_no: string;
  customer_name: string;
  delivery_date: string;
  currency: string;
  total_amount: number;
  message: string;
}

const DAY = 86_400_000;
const today = () => new Date(new Date().toDateString()); // 本地零点
const daysBetween = (d1: Date, d2: Date) => Math.round((d1.getTime() - d2.getTime()) / DAY);

/** 解析 YYYY-MM-DD 为本地日期；无效返回 null */
function parseDate(s: string | null | undefined): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const d = new Date(s.slice(0, 10) + 'T00:00:00');
  return isNaN(d.getTime()) ? null : d;
}

/** 异常引擎（纯规则）：对全部 active 订单计算异常清单 */
export function computeAnomalies(): Anomaly[] {
  const rules = getRules();
  const orders = db.prepare(`SELECT * FROM orders WHERE status='active' ORDER BY delivery_date ASC`).all() as any[];
  const now = today();
  const nodeStmt = db.prepare(`SELECT node FROM order_events WHERE order_id=? ORDER BY id DESC LIMIT 1`);
  const lastEventStmt = db.prepare(`SELECT MAX(event_date, created_at) AS last_at FROM order_events WHERE order_id=?`);
  const out: Anomaly[] = [];

  for (const o of orders) {
    const base = {
      order_id: o.id, order_no: o.order_no || `#${o.id}`, customer_name: o.customer_name,
      delivery_date: o.delivery_date, currency: o.currency, total_amount: o.total_amount,
    };
    const lastNode = (nodeStmt.get(o.id) as any)?.node as string | undefined;
    const shipped = lastNode === 'shipped' || lastNode === 'dispatched' || lastNode === 'balance_received';

    const dlv = parseDate(o.delivery_date);
    if (dlv && !shipped) {
      const diff = daysBetween(dlv, now); // >0 表示还有几天；<0 表示已逾期
      if (diff < 0) {
        out.push({ ...base, type: 'overdue', level: 'high', message: `交期已逾期 ${-diff} 天（交期 ${o.delivery_date}），尚未出货` });
      } else if (rules.days_before.includes(diff)) {
        out.push({
          ...base, type: 'due_soon', level: diff <= 3 ? 'high' : diff <= 7 ? 'medium' : 'low',
          message: `距离交期还有 ${diff} 天（${o.delivery_date}），请确认生产进度`,
        });
      }
    }

    const created = parseDate(o.created_at);
    if (created && daysBetween(now, created) >= rules.deposit_days) {
      const hasDeposit = db.prepare(`SELECT 1 FROM order_events WHERE order_id=? AND node='deposit_received' LIMIT 1`).get(o.id);
      if (!hasDeposit) {
        out.push({ ...base, type: 'deposit_pending', level: 'medium', message: `下单已超 ${rules.deposit_days} 天，未记录定金到账` });
      }
    }

    const lastRow = lastEventStmt.get(o.id) as any;
    const lastAt = parseDate(lastRow?.last_at);
    if (lastAt) {
      const idle = daysBetween(now, lastAt);
      if (idle >= rules.stalled_days && !shipped) {
        out.push({ ...base, type: 'stalled', level: 'low', message: `已 ${idle} 天没有任何进度更新，请跟进` });
      }
    }
  }
  // 排序：级别高在前
  const order = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level] || a.order_id - b.order_id);
}
