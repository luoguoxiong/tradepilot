import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  createId,
  DISCOVERY_STATUS,
  type DiscoveryDraft,
  type DiscoveryType,
} from '@tradepilot/core';
import { aiDiscovery } from './schema/index.js';
import type { Tx } from './tenant.js';

/**
 * 13 AI 外贸经理 · 数据访问层（API 实时发现 与 worker 经营报告 共用，保证单一实现点）。
 *
 * 为什么放在 db 包：发现既要被 `GET /manager/discoveries` 实时刷新（API），
 * 也要被 `business_analysis` 图在报告生成时复用（worker），把聚合 SQL 收敛在此，
 * 才能同时满足 13 §4「洞察必须基于可核实数据」与 08 §2.4「ai_discovery 单一写入口径」。
 *
 * 所有函数须在 `withOrg(db, orgId, tx => ...)` 事务内调用（RLS fail-closed，02 §4.3）。
 */

/** 发现列表返回上限（页面一次性展示，13 §1.2 无分页） */
export const DISCOVERY_LIST_LIMIT = 50;

interface RowsResult {
  rows: Record<string, unknown>[];
}

function readRows(result: unknown): Record<string, unknown>[] {
  return (result as RowsResult).rows ?? [];
}

/**
 * 机会候选聚合：近窗 vs 前窗询盘量（按国家），并附带近窗高频产品名（quotation_item 快照）。
 * 口径与 15 数据中心一致：询盘 = conversation.created_at 落在窗口内且客户未软删。
 */
export async function fetchOpportunityCandidates(
  tx: Tx,
  range: { recentStart: Date; recentEnd: Date; previousStart: Date },
): Promise<{ country: string; recent: number; previous: number; productName: string | null }[]> {
  const countsResult = await tx.execute(sql`
    SELECT c.country AS country,
      count(*) FILTER (WHERE v.created_at >= ${range.recentStart})::int AS recent,
      count(*) FILTER (WHERE v.created_at < ${range.recentStart})::int AS previous
    FROM conversation v
    JOIN customer c ON c.id = v.customer_id
    WHERE c.deleted_at IS NULL
      AND v.created_at >= ${range.previousStart}
      AND v.created_at < ${range.recentEnd}
    GROUP BY c.country
  `);

  const productResult = await tx.execute(sql`
    SELECT country, product_name FROM (
      SELECT c.country AS country,
        qi.product_name AS product_name,
        row_number() OVER (PARTITION BY c.country ORDER BY count(*) DESC, qi.product_name) AS rn
      FROM quotation_item qi
      JOIN quotation q ON q.id = qi.quotation_id
      JOIN customer c ON c.id = q.customer_id
      WHERE c.deleted_at IS NULL
        AND q.created_at >= ${range.recentStart}
        AND q.created_at < ${range.recentEnd}
      GROUP BY c.country, qi.product_name
    ) ranked
    WHERE rn = 1
  `);

  const productByCountry = new Map<string, string>();
  for (const row of readRows(productResult)) {
    productByCountry.set(String(row['country']), String(row['product_name']));
  }

  return readRows(countsResult).map((row) => {
    const country = String(row['country']);
    return {
      country,
      recent: Number(row['recent'] ?? 0),
      previous: Number(row['previous'] ?? 0),
      productName: productByCountry.get(country) ?? null,
    };
  });
}

/**
 * 静默高价值客户：score ≥ 阈值、非 cold、且「最后触达」早于 cutoff。
 * 最后触达 = max(customer_activity.created_at, conversation.last_message_at, customer.created_at)。
 */
export async function fetchStaleHighValueCustomers(
  tx: Tx,
  params: { scoreThreshold: number; cutoff: Date; limit?: number },
): Promise<
  {
    customerId: string;
    companyName: string;
    country: string | null;
    score: number;
    lastTouchAt: Date | null;
  }[]
> {
  const result = await tx.execute(sql`
    SELECT c.id, c.company_name, c.country, c.score,
      COALESCE(touch.last_at, c.created_at) AS last_touch_at
    FROM customer c
    LEFT JOIN (
      SELECT cid, max(at) AS last_at FROM (
        SELECT customer_id AS cid, max(created_at) AS at FROM customer_activity GROUP BY customer_id
        UNION ALL
        SELECT customer_id AS cid, max(last_message_at) AS at FROM conversation GROUP BY customer_id
      ) unioned
      GROUP BY cid
    ) touch ON touch.cid = c.id
    WHERE c.deleted_at IS NULL
      AND c.score IS NOT NULL
      AND c.score >= ${params.scoreThreshold}
      AND c.stage <> 'cold'
      AND COALESCE(touch.last_at, c.created_at) < ${params.cutoff}
    ORDER BY c.score DESC, last_touch_at ASC
    LIMIT ${params.limit ?? 20}
  `);

  return readRows(result).map((row) => ({
    customerId: String(row['id']),
    companyName: String(row['company_name']),
    country: row['country'] === null ? null : String(row['country']),
    score: Number(row['score'] ?? 0),
    lastTouchAt: row['last_touch_at'] ? new Date(row['last_touch_at'] as string) : null,
  }));
}

/** 读列表（status != expired；executed 仍展示，供页面显示已执行状态） */
export async function listDiscoveries(
  tx: Tx,
  opts: { type?: DiscoveryType | 'all' } = {},
): Promise<
  {
    id: string;
    type: string;
    title: string;
    detail: string;
    evidence: { text: string; source?: string; ref?: string }[];
    suggestion: Record<string, unknown>;
    status: string;
    executedRef: Record<string, unknown> | null;
    executedAt: Date | null;
    createdAt: Date;
  }[]
> {
  const rows = await tx
    .select({
      id: aiDiscovery.id,
      type: aiDiscovery.type,
      title: aiDiscovery.title,
      detail: aiDiscovery.detail,
      evidence: aiDiscovery.evidence,
      suggestion: aiDiscovery.suggestion,
      status: aiDiscovery.status,
      executedRef: aiDiscovery.executedRef,
      executedAt: aiDiscovery.executedAt,
      createdAt: aiDiscovery.createdAt,
    })
    .from(aiDiscovery)
    .where(
      opts.type && opts.type !== 'all'
        ? and(ne(aiDiscovery.status, DISCOVERY_STATUS.EXPIRED), eq(aiDiscovery.type, opts.type))
        : ne(aiDiscovery.status, DISCOVERY_STATUS.EXPIRED),
    )
    .orderBy(desc(aiDiscovery.createdAt))
    .limit(DISCOVERY_LIST_LIMIT);
  return rows.map((row) => ({ ...row, evidence: row.evidence ?? [] }));
}

/**
 * 幂等落库（键 = type + title）：
 * - 已存在 → 仅刷新 detail/evidence/suggestion/updatedAt，**保留** status/executedRef（已执行动作不因刷新而丢失）；
 * - 不存在 → 以 status='new' 插入；
 * - 本轮未检出的历史 'new' 行 → 标记 expired（页面只呈现当前有效发现，避免陈旧结论堆积）。
 */
export async function upsertDiscoveries(
  tx: Tx,
  orgId: string,
  drafts: DiscoveryDraft[],
): Promise<{ id: string; draft: DiscoveryDraft }[]> {
  const existing = await tx
    .select({
      id: aiDiscovery.id,
      type: aiDiscovery.type,
      title: aiDiscovery.title,
      status: aiDiscovery.status,
    })
    .from(aiDiscovery);
  const existingKey = new Map(existing.map((row) => [`${row.type}|${row.title}`, row]));

  const result: { id: string; draft: DiscoveryDraft }[] = [];
  const keptIds: string[] = [];

  for (const draft of drafts) {
    const hit = existingKey.get(`${draft.type}|${draft.title}`);
    if (hit) {
      await tx
        .update(aiDiscovery)
        .set({
          detail: draft.detail,
          evidence: draft.evidence,
          suggestion: draft.suggestion,
          updatedAt: new Date(),
        })
        .where(eq(aiDiscovery.id, hit.id));
      keptIds.push(hit.id);
      result.push({ id: hit.id, draft });
      continue;
    }
    const id = createId('disc');
    await tx.insert(aiDiscovery).values({
      id,
      orgId,
      type: draft.type,
      title: draft.title,
      detail: draft.detail,
      evidence: draft.evidence,
      suggestion: draft.suggestion,
      status: DISCOVERY_STATUS.NEW,
    });
    keptIds.push(id);
    result.push({ id, draft });
  }

  const staleIds = existing
    .filter((row) => row.status === DISCOVERY_STATUS.NEW && !keptIds.includes(row.id))
    .map((row) => row.id);
  if (staleIds.length > 0) {
    await tx
      .update(aiDiscovery)
      .set({ status: DISCOVERY_STATUS.EXPIRED, updatedAt: new Date() })
      .where(inArray(aiDiscovery.id, staleIds));
  }

  return result;
}

/** 标记发现已执行（一键动作完成回写） */
export async function markDiscoveryExecuted(
  tx: Tx,
  discoveryId: string,
  executedRef: Record<string, unknown>,
): Promise<void> {
  await tx
    .update(aiDiscovery)
    .set({
      status: DISCOVERY_STATUS.EXECUTED,
      executedRef,
      executedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(aiDiscovery.id, discoveryId));
}
