/**
 * Memory Manager（后端技术方案 05 §5 三层落地）。
 * - Working 层：LangGraph State + checkpointer（任务内，compiler 承载）；
 * - Task 层：ai_task.outputs（结构化产出，runner 落库）；
 * - Org 层：本文件读侧助手——① customer_insight 客户画像 ② 会话最近消息（截断）
 *   ③ org memory（拒绝反馈回流，M3 空实现，写侧随反馈闭环 P1 落地）。
 * 全部走 withOrg（RLS fail-closed）；供 workflows flow 节点组装 LLM 上下文注入。
 */
import { and, desc, eq } from 'drizzle-orm';
import { schema, withOrg, type Db } from '@tradepilot/db';
import type { EmailMessageRef } from '@tradepilot/shared';

/** 单条消息正文截断长度（上下文注入防 token 超限） */
const MESSAGE_MAX_CHARS = 2000;
/** 会话最近消息默认条数 */
const RECENT_MESSAGE_LIMIT = 10;

/** 客户画像快照（customer + customer_insight 聚合，flow 节点 prompt 变量来源） */
export interface CustomerInsightSnapshot {
  customer: {
    id: string;
    companyName: string;
    country: string;
    industry: string | null;
    stage: string;
    tier: 'high' | 'medium' | 'low';
    isFormal: boolean;
    remark: string | null;
  };
  /** insightType → 最新洞察（uq_customer_insight_type 每类型单行） */
  insights: Record<
    string,
    { value: string | null; confidence: string | null; reasons: { text: string }[] }
  >;
}

/** ① 客户画像读：customer 基础档案 + customer_insight 全量（缺失类型键缺省） */
export async function loadCustomerInsights(
  db: Db,
  orgId: string,
  customerId: string,
): Promise<CustomerInsightSnapshot | null> {
  return withOrg(db, orgId, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.customer)
      .where(and(eq(schema.customer.id, customerId), eq(schema.customer.orgId, orgId)))
      .limit(1);
    if (!row) {
      return null;
    }
    const insightRows = await tx
      .select({
        insightType: schema.customerInsight.insightType,
        value: schema.customerInsight.value,
        confidence: schema.customerInsight.confidence,
        reasons: schema.customerInsight.reasons,
      })
      .from(schema.customerInsight)
      .where(eq(schema.customerInsight.customerId, customerId));

    const insights: CustomerInsightSnapshot['insights'] = {};
    for (const ins of insightRows) {
      insights[ins.insightType] = {
        value: ins.value,
        confidence: ins.confidence,
        reasons: ins.reasons ?? [],
      };
    }
    const score = row.score ?? 0;
    return {
      customer: {
        id: row.id,
        companyName: row.companyName,
        country: row.country,
        industry: row.industry,
        stage: row.stage,
        tier: score >= 85 ? 'high' : score >= 60 ? 'medium' : 'low',
        isFormal: row.isFormal,
        remark: row.remark,
      },
      insights,
    };
  });
}

/**
 * ② 会话最近消息（时间正序，最近 limit 条）：EmailMessageRef 同构 shared 契约，
 * subject 取会话主题，body 单条截断 MESSAGE_MAX_CHARS（load_thread / check_replied 复用）。
 */
export async function loadRecentMessages(
  db: Db,
  orgId: string,
  conversationId: string,
  opts: { limit?: number } = {},
): Promise<EmailMessageRef[]> {
  const limit = opts.limit ?? RECENT_MESSAGE_LIMIT;
  return withOrg(db, orgId, async (tx) => {
    const [conv] = await tx
      .select({ subject: schema.conversation.subject })
      .from(schema.conversation)
      .where(and(eq(schema.conversation.id, conversationId), eq(schema.conversation.orgId, orgId)))
      .limit(1);
    if (!conv) {
      return [];
    }
    const rows = await tx
      .select({
        id: schema.message.id,
        direction: schema.message.direction,
        content: schema.message.content,
        language: schema.message.language,
        senderType: schema.message.senderType,
        sentAt: schema.message.sentAt,
        createdAt: schema.message.createdAt,
      })
      .from(schema.message)
      .where(and(eq(schema.message.conversationId, conversationId), eq(schema.message.orgId, orgId)))
      .orderBy(desc(schema.message.createdAt))
      .limit(limit);
    return rows
      .reverse()
      .map((m) => ({
        messageId: m.id,
        direction: m.direction,
        subject: conv.subject,
        body: m.content.length > MESSAGE_MAX_CHARS ? `${m.content.slice(0, MESSAGE_MAX_CHARS)}…` : m.content,
        language: m.language,
        sentAt: (m.sentAt ?? m.createdAt).toISOString(),
        senderType: m.senderType,
      }));
  });
}

/**
 * ③ Org memory 读（拒绝原因/编辑差异摘要注入，05 §4.3）：
 * M3 空实现返回空数组；回流写侧（拒绝原因 → 客户维度上下文包）随反馈闭环 P1 落地。
 */
export async function readOrgMemory(
  _db: Db,
  _orgId: string,
  _customerId?: string,
): Promise<{ type: string; summary: string }[]> {
  return [];
}
