/**
 * QuotaReset 外部调用日额度重置（后端技术方案 04 §3.1 / 06 §3）：
 * 每 24h 跑一次。M3 配额 key 按日分片（quota:{org}:{emp}:{yyyyMMdd}，TTL 48h）天然轮换，
 * 此处仅做日界巡检与日志留痕；org 时区日界的精确重置随 M4 外部集成实装（配额消耗真实化后对齐）。
 */
import type { Logger } from 'pino';

/** 周期（04 §3.1：每日 00:00） */
export const QUOTA_RESET_INTERVAL_MS = 24 * 3600_000;

export function startQuotaResetLoop(logger: Logger): () => void {
  const timer = setInterval(() => {
    logger.info({ at: new Date().toISOString() }, '外部调用日额度日界轮换（quota key 按日分片自动生效）');
  }, QUOTA_RESET_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
