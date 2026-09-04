/**
 * 异常引擎单测（红线R5：四类规则×边界日期，隔离DB）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = `/tmp/tp-order-ano-${Date.now()}.db`;

const { db } = await import('../db.js');
const { computeAnomalies, getRules } = await import('../services/anomalies.js');

const DAY = 86_400_000;
const dateStr = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

function seed(order: Partial<Record<string, unknown>>, events: Array<{ node: string; ago: number }> = []): number {
  const ins = db.prepare(`INSERT INTO orders(order_no, customer_name, delivery_date, currency, total_amount, status, created_at)
    VALUES (?,?,?,?,?,?,?)`).run(
    order.order_no || 'PO-X', order.customer_name || 'C', order.delivery_date || '',
    'USD', 1000, order.status || 'active',
    (order.created_at as string) || dateStr(-30),
  );
  const id = Number(ins.lastInsertRowid);
  const insEv = db.prepare(`INSERT INTO order_events(order_id, node, event_date, created_at) VALUES (?,?,?,?)`);
  for (const e of events) insEv.run(id, e.node, dateStr(-e.ago), dateStr(-e.ago));
  return id;
}

test('规则默认值', () => {
  assert.deepEqual(getRules(), { days_before: [7, 3, 1], deposit_days: 7, stalled_days: 14 });
});

test('逾期：交期已过且未出货 → overdue(high)', () => {
  const id = seed({ order_no: 'OD-1', delivery_date: dateStr(-3) }, [{ node: 'producing', ago: 5 }]);
  const a = computeAnomalies().find((x) => x.order_id === id && x.type === 'overdue');
  assert.ok(a);
  assert.equal(a!.level, 'high');
  assert.match(a!.message, /逾期 3 天/);
});

test('交期临近：恰好 7/3/1 天触发，4 天不触发', () => {
  const id7 = seed({ order_no: 'DS-7', delivery_date: dateStr(7) }, [{ node: 'producing', ago: 1 }]);
  const id4 = seed({ order_no: 'DS-4', delivery_date: dateStr(4) }, [{ node: 'producing', ago: 1 }]);
  const all = computeAnomalies();
  assert.ok(all.find((x) => x.order_id === id7 && x.type === 'due_soon'));
  assert.ok(!all.find((x) => x.order_id === id4 && x.type === 'due_soon'));
});

test('已出货订单不再报逾期/临期', () => {
  const id = seed({ order_no: 'SH-1', delivery_date: dateStr(-5) }, [
    { node: 'producing', ago: 20 }, { node: 'shipped', ago: 6 },
  ]);
  const all = computeAnomalies().filter((x) => x.order_id === id);
  assert.ok(!all.find((x) => x.type === 'overdue'));
  assert.ok(!all.find((x) => x.type === 'due_soon'));
});

test('定金未到：创建超 N 天且无 deposit_received → deposit_pending', () => {
  const id = seed({ order_no: 'DP-1', created_at: dateStr(-10) }, [{ node: 'order_confirmed', ago: 9 }]);
  assert.ok(computeAnomalies().find((x) => x.order_id === id && x.type === 'deposit_pending'));
  // 有定金到账则不报
  const id2 = seed({ order_no: 'DP-2', created_at: dateStr(-10) }, [
    { node: 'order_confirmed', ago: 9 }, { node: 'deposit_received', ago: 8 },
  ]);
  assert.ok(!computeAnomalies().find((x) => x.order_id === id2 && x.type === 'deposit_pending'));
});

test('长期停滞：最近事件超 N 天 → stalled', () => {
  const id = seed({ order_no: 'ST-1', delivery_date: dateStr(60) }, [{ node: 'producing', ago: 15 }]);
  assert.ok(computeAnomalies().find((x) => x.order_id === id && x.type === 'stalled'));
  const id2 = seed({ order_no: 'ST-2', delivery_date: dateStr(60) }, [{ node: 'producing', ago: 13 }]);
  assert.ok(!computeAnomalies().find((x) => x.order_id === id2 && x.type === 'stalled'));
});

test('closed 订单不参与异常计算', () => {
  seed({ order_no: 'CL-1', delivery_date: dateStr(-10), status: 'closed' }, [{ node: 'producing', ago: 12 }]);
  assert.ok(!computeAnomalies().find((x) => x.order_no === 'CL-1'));
});
