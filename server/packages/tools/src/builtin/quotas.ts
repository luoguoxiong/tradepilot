/**
 * org 时区与外部配额辅助（M4 #6，后端技术方案 06 §3）：
 * - getOrgTimezone：org.timezone 读取（60s 进程内 memo，避免每次工具调用打点）；
 * - assertOrgSearchQuota：org 级搜索/抓取日额度令牌桶（Redis INCRBY + 当地日 key，
 *   key `orgsearch:{orgId}:{yyyyMMdd@tz}`，TTL 48h）——员工级配额（registry.assertQuota）
 *   之上的一层供应商额度保护，超限 42901。
 */
import { eq } from 'drizzle-orm';
import { schema, type Tx } from '@tradepilot/db';
import { BizException, ErrorCode, zonedDayKey } from '@tradepilot/core';
import type { ToolContext } from '../registry.js';

const TZ_CACHE_TTL_MS = 60_000;
const tzCache = new Map<string, { tz: string; at: number }>();

/** org.timezone（缺省 UTC）；缓存 60s（org 设置低频变更，进程多实例各自过期收敛） */
export async function getOrgTimezone(orgId: string, tx: Tx): Promise<string> {
  const hit = tzCache.get(orgId);
  const now = Date.now();
  if (hit && now - hit.at < TZ_CACHE_TTL_MS) {
    return hit.tz;
  }
  const [row] = await tx
    .select({ timezone: schema.org.timezone })
    .from(schema.org)
    .where(eq(schema.org.id, orgId))
    .limit(1);
  const tz = row?.timezone || 'UTC';
  tzCache.set(orgId, { tz, at: now });
  return tz;
}

let orgSearchDailyLimit = 2000;

/** org 级搜索/抓取日额度上限注入（worker 启动时由 env 传入；缺省 2000） */
export function configureOrgSearchQuota(limit: number): void {
  if (Number.isFinite(limit) && limit > 0) {
    orgSearchDailyLimit = limit;
  }
}

/**
 * org 级搜索/抓取日额度令牌桶（06 §3）：weight 与工具 quotaWeight 同口径
 * （search ×1 / crawl ×2）。按 org 时区日界轮换（zonedDayKey），超限 RATE_LIMITED。
 */
export async function assertOrgSearchQuota(
  ctx: Pick<ToolContext, 'orgId' | 'redis' | 'now' | 'tx'>,
  weight: number,
): Promise<void> {
  const tz = await getOrgTimezone(ctx.orgId, ctx.tx);
  const day = zonedDayKey(ctx.now, tz);
  const key = `orgsearch:${ctx.orgId}:${day}`;
  const used = await ctx.redis.incrby(key, weight);
  if (used === weight) {
    await ctx.redis.expire(key, 48 * 3600);
  }
  if (used > orgSearchDailyLimit) {
    throw new BizException(
      ErrorCode.RATE_LIMITED,
      `org 搜索/抓取日额度已用尽（${orgSearchDailyLimit}，${tz} 当地日 ${day}）`,
    );
  }
}
