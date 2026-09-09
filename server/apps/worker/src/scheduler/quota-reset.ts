/**
 * QuotaReset 外部调用日额度重置（M4 #6/C2，后端技术方案 04 §3.1 / 06 §3）：
 * 每 5 分钟扫描全部 org，按 org.timezone 计算墙钟日（zonedDayKey），以 Redis SET NX
 * 写入日界标记（quotareset:{orgId}:{yyyyMMdd@tz}，TTL 48h）——
 *   - SET 成功 = 该 org 进入新的当地日（日界滚动事件，日志留痕 + 通知入队）；
 *   - 配额本身无需清零：员工级（quota:{org}:{emp}:{day@tz}）与 org 级（orgsearch:{org}:{day@tz}）
 *     key 均按 org 时区日分片，当地零点后自动落在新 key 上，旧 key 随 TTL 过期。
 * 即「精确重置」由分片 key + 本扫描器的日界留痕共同构成。
 */
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { schema, type Db } from '@tradepilot/db';
import { zonedDayKey } from '@tradepilot/core';
import type { Logger } from 'pino';

/** 扫描周期（04 §3.1）：5min（日界检测误差 ≤5min，配额 key 轮换本身精确到当地零点） */
export const QUOTA_RESET_INTERVAL_MS = 5 * 60_000;
const MARKER_TTL_SECONDS = 48 * 3600;

export interface QuotaResetScannerDeps {
  db: Db;
  redis: Redis;
  logger: Logger;
}

export class QuotaResetScanner {
  constructor(private readonly deps: QuotaResetScannerDeps) {}

  /** 单轮扫描：返回发生日界滚动的 org 数（测试可直接调用） */
  async tick(now = new Date()): Promise<number> {
    const { db, redis, logger } = this.deps;
    // 跨租户扫描（sched 角色白名单口径，02 §4.3）
    const orgs = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.sched', '1', true)`);
      return tx
        .select({ id: schema.org.id, timezone: schema.org.timezone })
        .from(schema.org);
    });

    let rolled = 0;
    for (const orgRow of orgs) {
      const tz = orgRow.timezone || 'UTC';
      const day = zonedDayKey(now, tz);
      try {
        const created = await redis.set(
          `quotareset:${orgRow.id}:${day}`,
          '1',
          'EX',
          MARKER_TTL_SECONDS,
          'NX',
        );
        if (created === 'OK') {
          rolled += 1;
          logger.info(
            { orgId: orgRow.id, timezone: tz, localDay: day },
            'org 外部调用日额度进入新当地日（配额 key 自动轮换）',
          );
        }
      } catch (err) {
        logger.warn(
          { orgId: orgRow.id, err: err instanceof Error ? err.message : String(err) },
          '配额日界标记写入失败，下轮重试',
        );
      }
    }
    return rolled;
  }
}

/** startLoop 装配便捷入口（worker bootstrap 用） */
export function startQuotaResetScanner(
  deps: QuotaResetScannerDeps,
): { scanner: QuotaResetScanner } {
  return { scanner: new QuotaResetScanner(deps) };
}
