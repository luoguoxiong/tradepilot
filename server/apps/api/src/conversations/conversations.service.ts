import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { BizException, ErrorCode } from '@tradepilot/core';
import { schema, withOrg, type Db } from '@tradepilot/db';
import {
  applyOwnerScope,
  notDeleted,
  resolveScope,
  scopeAnd,
  type OrgScopeContext,
} from '@tradepilot/db';
import { DB } from '../db/db.module.js';
import type { ListConversationsQuery } from './conversations.dto.js';

/**
 * 06 AI 销售工作台 · 会话读侧（接口 06 §3.1，M5-A3）：
 * - 列表：多邮箱聚合视图（FR-11），scope 经 customer.ownerId 注入（sales=self 只看自己客户会话）；
 * - 详情：上下文 + 消息时间线（含 draft），读即清未读；
 * - Copilot：conversation_insight（M5-C4 写回挂接前的空态兜底口径）。
 */

export interface ConversationListItem {
  conversationId: string;
  contactName: string;
  companyName: string;
  priority: string;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  mailboxId: string | null;
}

export interface ConversationMessageItem {
  messageId: string;
  direction: string;
  senderName: string;
  content: string;
  language: string | null;
  sentAt: string;
  status: string;
}

export interface ConversationDetail {
  conversationId: string;
  customerId: string;
  companyName: string;
  contactName: string;
  stage: string;
  mailboxId: string | null;
  messages: ConversationMessageItem[];
}

export interface CopilotData {
  intent: string;
  purchaseProbability: number;
  stage: string;
  suggestions: { suggestionId: string; label: string; checked: boolean; kind: 'content' | 'process' }[];
  citations: { docId: string; docName: string; chunkId: string }[];
  insight: { confidence: number; reasons: { text: string; evidence?: string; source?: string }[] };
}

@Injectable()
export class ConversationsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 06 §3.1 会话列表（keyword/priority/unreadOnly/mailboxId + scope 裁剪 + 分页） */
  async list(
    ctx: OrgScopeContext,
    query: ListConversationsQuery & {
      page: number;
      pageSize: number;
      keyword?: string;
      sortOrder?: 'asc' | 'desc';
    },
  ): Promise<{ items: ConversationListItem[]; total: number; page: number; pageSize: number }> {
    const scope = resolveScope(ctx.role, ctx.scope);
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const conditions: (SQL | undefined)[] = [
        notDeleted(schema.customer.deletedAt),
        applyOwnerScope(schema.customer.ownerId, { ...ctx, scope }),
      ];
      if (query.priority) {
        conditions.push(eq(schema.conversation.priority, query.priority));
      }
      if (query.unreadOnly) {
        conditions.push(sql`${schema.conversation.unreadCount} > 0`);
      }
      if (query.mailboxId) {
        conditions.push(eq(schema.conversation.mailboxId, query.mailboxId));
      }
      if (query.keyword) {
        const kw = `%${query.keyword}%`;
        conditions.push(
          or(
            ilike(schema.conversation.subject, kw),
            ilike(schema.conversation.lastMessagePreview, kw),
            ilike(schema.customer.companyName, kw),
          ),
        );
      }
      const where = scopeAnd(...conditions);

      const rows = await tx
        .select({
          conversationId: schema.conversation.id,
          contactName: sql<string>`coalesce(${schema.contact.name}, ${schema.customer.companyName})`,
          companyName: schema.customer.companyName,
          priority: schema.conversation.priority,
          lastMessagePreview: schema.conversation.lastMessagePreview,
          lastMessageAt: schema.conversation.lastMessageAt,
          unreadCount: schema.conversation.unreadCount,
          mailboxId: schema.conversation.mailboxId,
        })
        .from(schema.conversation)
        .innerJoin(schema.customer, eq(schema.customer.id, schema.conversation.customerId))
        .leftJoin(schema.contact, eq(schema.contact.id, schema.conversation.contactId))
        .where(where)
        .orderBy(
          query.sortOrder === 'asc'
            ? asc(schema.conversation.lastMessageAt)
            : desc(schema.conversation.lastMessageAt),
        )
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);

      const [countRow] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.conversation)
        .innerJoin(schema.customer, eq(schema.customer.id, schema.conversation.customerId))
        .leftJoin(schema.contact, eq(schema.contact.id, schema.conversation.contactId))
        .where(where);

      return {
        items: rows.map((r) => ({
          ...r,
          lastMessageAt: r.lastMessageAt ? r.lastMessageAt.toISOString() : null,
        })),
        total: countRow?.n ?? 0,
        page: query.page,
        pageSize: query.pageSize,
      };
    });
  }

  /** 06 §2 会话详情：上下文 + 消息时间线；读即清未读（FR-02） */
  async detail(ctx: OrgScopeContext, conversationId: string): Promise<ConversationDetail> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const [conv] = await tx
        .select({
          conversationId: schema.conversation.id,
          customerId: schema.customer.id,
          companyName: schema.customer.companyName,
          contactName: sql<string>`coalesce(${schema.contact.name}, ${schema.customer.companyName})`,
          stage: schema.customer.stage,
          mailboxId: schema.conversation.mailboxId,
          ownerId: schema.customer.ownerId,
        })
        .from(schema.conversation)
        .innerJoin(schema.customer, eq(schema.customer.id, schema.conversation.customerId))
        .leftJoin(schema.contact, eq(schema.contact.id, schema.conversation.contactId))
        .where(
          and(
            eq(schema.conversation.id, conversationId),
            notDeleted(schema.customer.deletedAt),
          ),
        )
        .limit(1);
      if (!conv) {
        throw new BizException(ErrorCode.NOT_FOUND, '会话不存在');
      }
      const scope = resolveScope(ctx.role, ctx.scope);
      if (scope === 'self' && conv.ownerId !== ctx.userId) {
        throw new BizException(ErrorCode.FORBIDDEN, '无权限访问该会话');
      }

      const messages = await tx
        .select({
          messageId: schema.message.id,
          direction: schema.message.direction,
          senderName: schema.message.senderName,
          content: schema.message.content,
          language: schema.message.language,
          status: schema.message.status,
          sentAt: schema.message.sentAt,
          createdAt: schema.message.createdAt,
        })
        .from(schema.message)
        .where(eq(schema.message.conversationId, conversationId))
        .orderBy(asc(schema.message.createdAt));

      // 读即清未读（FR-02）
      await tx
        .update(schema.conversation)
        .set({ unreadCount: 0, updatedAt: new Date() })
        .where(
          and(eq(schema.conversation.id, conversationId), sql`${schema.conversation.unreadCount} > 0`),
        );

      return {
        conversationId: conv.conversationId,
        customerId: conv.customerId,
        companyName: conv.companyName,
        contactName: conv.contactName,
        stage: conv.stage,
        mailboxId: conv.mailboxId,
        messages: messages.map((m) => ({
          messageId: m.messageId,
          direction: m.direction,
          senderName: m.senderName,
          content: m.content,
          language: m.language,
          sentAt: (m.sentAt ?? m.createdAt).toISOString(),
          status: m.status,
        })),
      };
    });
  }

  /** 06 §1.3 Copilot 数据（意图/概率/建议；无洞察行为空态兜底，M5-C4 写回后富化） */
  async copilot(ctx: OrgScopeContext, conversationId: string): Promise<CopilotData> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const [conv] = await tx
        .select({
          customerId: schema.conversation.customerId,
          stage: schema.customer.stage,
          ownerId: schema.customer.ownerId,
        })
        .from(schema.conversation)
        .innerJoin(schema.customer, eq(schema.customer.id, schema.conversation.customerId))
        .where(
          and(eq(schema.conversation.id, conversationId), notDeleted(schema.customer.deletedAt)),
        )
        .limit(1);
      if (!conv) {
        throw new BizException(ErrorCode.NOT_FOUND, '会话不存在');
      }
      const scope = resolveScope(ctx.role, ctx.scope);
      if (scope === 'self' && conv.ownerId !== ctx.userId) {
        throw new BizException(ErrorCode.FORBIDDEN, '无权限访问该会话');
      }

      const [insight] = await tx
        .select()
        .from(schema.conversationInsight)
        .where(eq(schema.conversationInsight.conversationId, conversationId))
        .limit(1);

      return {
        intent: insight?.intent ?? 'other',
        purchaseProbability: insight?.purchaseProbability ?? 0,
        stage: conv.stage,
        suggestions: (insight?.suggestions ?? []).map((s) => ({
          suggestionId: s.suggestionId,
          label: s.label,
          checked: false,
          kind: 'content' as const,
        })),
        citations: (insight?.citations ?? []).map((c) => ({
          docId: c.docId,
          docName: c.docName ?? '',
          chunkId: c.chunkId ?? '',
        })),
        // ER 05 conversation_insight 不含置信度列（意图判定为规则/LLM 直出）；
        // 证据链随 M5-C4 洞察写回挂接富化，当前为空态
        insight: { confidence: 0, reasons: [] },
      };
    });
  }
}
