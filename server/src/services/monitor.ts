import { db } from '../db.js';
import { config } from '../config.js';
import { computeAnomalies } from './anomalies.js';

let timer: NodeJS.Timeout | null = null;

/** 扫描一次：用当前异常集合刷新 reminders 表（未处理的旧记录整体替换） */
export function scanNow(): number {
  const anomalies = computeAnomalies();
  const refresh = db.transaction(() => {
    db.prepare(`DELETE FROM reminders WHERE resolved_at IS NULL`).run();
    const ins = db.prepare(`INSERT INTO reminders(order_id, type, message) VALUES (?,?,?)`);
    for (const a of anomalies) ins.run(a.order_id, a.type, a.message);
  });
  refresh();
  return anomalies.length;
}

/** 启动定时扫描（默认 30 分钟，ORDER_SCAN_INTERVAL_MS 可调） */
export function startMonitor(): void {
  scanNow();
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    try {
      const n = scanNow();
      console.log(`[monitor] 异常扫描完成：${n} 条`);
    } catch (e) {
      console.error('[monitor] 扫描失败:', e);
    }
  }, config.order.scanIntervalMs);
  timer.unref?.();
  console.log(`[monitor] 订单异常监控已启动（间隔 ${Math.round(config.order.scanIntervalMs / 60_000)} 分钟）`);
}
