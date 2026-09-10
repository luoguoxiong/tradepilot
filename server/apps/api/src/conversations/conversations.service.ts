import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { BizException, computeDeferredNextRunAt, createId, ErrorCode } from '@tradepilot/core';
import { schema, withOrg, type Db } from '@tradepilot/db';
import {
  applyOwnerScope,
  assertResourceAccess,
  notDeleted,
  resolveScope,
  scopeAnd,
  type OrgScopeContext,
  type Tx,
} from '@tradepilot/db';
import { LlmGateway } from '@tradepilot/runtime';
import { searchKnowledgeChunks, type KnowledgeSearchHit } from '@tradepilot/tools';
import type { Logger } from 'pino';
import pino from 'pino';
import { z } from 'zod';
import { DB } from '../db/db.module.js';
import { EnvService } from '../config/env.service.js';
import { PINO_ROOT } from '../common/logger/logger.factory.js';
import { sendConversationEmail } from './send-mail.helper.js';
import type {
  AiDraftDto,
  AskAiDto,
  ListConversationsQuery,
  SendMessageDto,
  SuggestionsApplyDto,
  UpdateMessageDto,
} from './conversations.dto.js';

/**
 * 06 AI 销售工作台 · 会话服务（接口 06，M5-A3 读侧 + M5-C1/C2 写侧）：
 * - 读侧：列表（多邮箱聚合）/ 详情（含 approvalId 派生）/ Copilot；
 * - 写侧：ai-draft / regenerate（LlmGateway scene=email_reply + knowledge_search 依据）、
 *   PUT /messages（编辑留痕 editedDiff）、send（分支 A 直发 / 分支 B 审批）、
 *   copilot/suggestions/apply（内容型插入草稿 / 流程型创建跟进任务）、ask-ai（RAG 检索）。
 */

/** 邮件回复草稿输出契约（与 @tradepilot/workflows draftReplySchema 同构，避免 API 引入 workflows 依赖；
 * mock provider 按 Zod 形状确定性产出，测试可断言） */
const draftReplyOutputSchema = z
  .object({
    subject: z.string().min(1),
    body: z.string().min(1),
    grounded: z.boolean(),
    missingInfo: z.array(z.string()).optional(),
  })
  .strict();

/** 审批超时缺省 48h（12 §7.2） */
const APPROVAL_TTL_MS = 48 * 3600 * 1000;

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
  /** 关联审批单（send 分支 B 派生：approval_request bizType=message + pending） */
  approvalId?: string;
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
  suggestions: {
    suggestionId: string;
    label: string;
    checked: boolean;
    kind: 'content' | 'process';
  }[];
  citations: { docId: string; docName: string; chunkId: string }[];
  insight: { confidence: number; reasons: { text: string; evidence?: string; source?: string }[] };
}

export interface CitationItem {
  docId: string;
  docName?: string;
  chunkId?: string;
}

/** §3.2 ai-draft / regenerate 响应 */
export interface AiDraftResult {
  draftId: string;
  content: string;
  basedOnMessageId: string;
  generatedAt: string;
  citations: CitationItem[];
  missingKnowledge?: boolean;
}

/** §3.3 send 双分支响应 */
export interface SendResult {
  messageId: string;
  status: 'sent' | 'draft';
  sentAt?: string;
  approval?: { approvalId: string; approvalType: 'email_send'; status: 'pending' };
}

/** §3.5 ask-ai 响应 */
export interface AskAiResult {
  answer: string;
  citations: CitationItem[];
}

@Injectable()
export class ConversationsService {
  private readonly log: Logger;
  private gateway: LlmGateway | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(EnvService) private readonly env?: EnvService,
    @Inject(PINO_ROOT) private readonly logger?: Logger,
  ) {
    this.log = this.logger ?? pino({ level: 'silent' });
  }

  /**
   * LlmGateway（懒装配）：
   * 16 FR-10 扩展后优先使用 org 在「系统设置 → AI 模型配置」选用的大语言模型
   * （含凭据解密，encryptionKey 缺省则该 org 台账凭据不可用）；
   * 未配置的 org 回落 mock provider 确定性产出，测试/演练可用。
   */
  private get llm(): LlmGateway {
    this.gateway ??= new LlmGateway(this.db, this.log, {
      provider: 'mock',
      defaultModel: 'mock-1',
      ...(this.env?.env.ENCRYPTION_KEY !== undefined && {
        encryptionKey: this.env.env.ENCRYPTION_KEY,
      }),
    });
    return this.gateway;
  }

  /** 邮箱驱动选项（凭据解密 + OAuth 客户端凭据，06 §2.4） */
  private get driverOptions() {
    const env = this.env?.env;
    return {
      encryptionKey: env?.ENCRYPTION_KEY ?? '0'.repeat(64),
      oauth: {
        googleClientId: env?.GOOGLE_CLIENT_ID || undefined,
        googleClientSecret: env?.GOOGLE_CLIENT_SECRET || undefined,
        microsoftClientId: env?.MICROSOFT_CLIENT_ID || undefined,
        microsoftClientSecret: env?.MICROSOFT_CLIENT_SECRET || undefined,
      },
    };
  }

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

      // approvalId 派生（M5-C1）：approval_request(bizType='message' AND bizId=message.id AND status='pending')
      const approvalByMessage = new Map<string, string>();
      if (messages.length > 0) {
        const pendingApprovals = await tx
          .select({
            approvalId: schema.approvalRequest.id,
            messageId: schema.approvalRequest.bizId,
          })
          .from(schema.approvalRequest)
          .where(
            and(
              eq(schema.approvalRequest.orgId, ctx.orgId),
              eq(schema.approvalRequest.bizType, 'message'),
              eq(schema.approvalRequest.status, 'pending'),
              inArray(
                schema.approvalRequest.bizId,
                messages.map((m) => m.messageId),
              ),
            ),
          );
        for (const p of pendingApprovals) {
          approvalByMessage.set(p.messageId, p.approvalId);
        }
      }

      // 读即清未读（FR-02）
      await tx
        .update(schema.conversation)
        .set({ unreadCount: 0, updatedAt: new Date() })
        .where(
          and(
            eq(schema.conversation.id, conversationId),
            sql`${schema.conversation.unreadCount} > 0`,
          ),
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
          ...(approvalByMessage.has(m.messageId)
            ? { approvalId: approvalByMessage.get(m.messageId)! }
            : {}),
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

  // ============================== M5-C1/C2 写侧 ==============================

  /** §3.2 POST /conversations/{id}/ai-draft：知识检索依据 → LLM 生成 → 新草稿消息落库 */
  async aiDraft(
    ctx: OrgScopeContext,
    conversationId: string,
    dto: AiDraftDto,
  ): Promise<AiDraftResult> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      await this.assertConvAccess(tx, ctx, conversationId);

      // basedOnMessageId 消息须属于该会话（40401 / 40001）
      const [base] = await tx
        .select({ id: schema.message.id, content: schema.message.content })
        .from(schema.message)
        .where(eq(schema.message.id, dto.basedOnMessageId))
        .limit(1);
      if (!base) {
        throw new BizException(ErrorCode.NOT_FOUND, '基于消息不存在');
      }
      if (!(await this.messageInConversation(tx, dto.basedOnMessageId, conversationId))) {
        throw new BizException(ErrorCode.BAD_REQUEST, 'basedOnMessageId 不属于该会话');
      }

      // 会话时间线（正序）+ 语言检测（最近一条 in 消息语言或 zh/en 规则）
      const thread = await this.loadThread(tx, conversationId);
      const language = this.detectLanguage(thread);

      // 知识检索（以被回复消息为 query，scene=sales_reply；依据挂 citations）
      const kb = await searchKnowledgeChunks(tx, ctx.orgId, {
        query: base.content,
        scene: 'sales_reply',
        topK: 5,
      });
      const citations: CitationItem[] = kb.results.map((r) => ({
        docId: r.docId,
        docName: r.docName,
        chunkId: r.chunkId,
      }));

      // LLM 生成（mock provider 确定性产出；红线：无依据 → grounded=false 不编造）
      const draft = await this.generateReplyDraft(
        ctx,
        thread,
        language,
        kb.results,
        dto.instruction,
      );

      const draftId = createId('msg');
      const now = new Date();
      await tx.insert(schema.message).values({
        id: draftId,
        orgId: ctx.orgId,
        conversationId,
        direction: 'out',
        senderType: 'ai',
        senderName: 'AI 销售助手',
        content: draft.body,
        language,
        status: 'draft',
        citations: citations.length > 0 ? citations : null,
        basedOnMessageId: dto.basedOnMessageId,
        createdAt: now,
        updatedAt: now,
      });

      return {
        draftId,
        content: draft.body,
        basedOnMessageId: dto.basedOnMessageId,
        generatedAt: now.toISOString(),
        citations,
        ...(kb.noResult || citations.length === 0 ? { missingKnowledge: true } : {}),
      };
    });
  }

  /** §3.2 POST /conversations/{id}/ai-draft/regenerate：新草稿消息（新 message id，不修改旧草稿） */
  async regenerate(
    ctx: OrgScopeContext,
    conversationId: string,
    dto: AiDraftDto,
  ): Promise<AiDraftResult> {
    return this.aiDraft(ctx, conversationId, dto);
  }

  /** PUT /messages/{id}：编辑/保存草稿；编辑差异 editedDiff 留痕（采纳率统计）；非 draft → 40901；空 → 42201 */
  async updateMessage(
    ctx: OrgScopeContext,
    messageId: string,
    dto: UpdateMessageDto,
  ): Promise<{ messageId: string; status: 'draft' }> {
    if (!dto.content || dto.content.trim().length === 0) {
      throw new BizException(ErrorCode.BIZ_VALIDATION, '内容不能为空（06 §3.2）');
    }
    const content = dto.content;
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const msg = await this.assertMessageAccess(tx, ctx, messageId);
      if (msg.status !== 'draft') {
        throw new BizException(ErrorCode.CONFLICT, '仅草稿可编辑（当前状态: ' + msg.status + '）');
      }

      const editedDiff =
        msg.content !== content
          ? [{ field: 'content' as const, before: msg.content, after: content }]
          : null;
      await tx
        .update(schema.message)
        .set({
          content,
          // 无实际变化时保留历史留痕（不覆盖既有 diff），仅内容变化才写本次差异
          ...(editedDiff ? { editedDiff } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.message.id, messageId));

      return { messageId, status: 'draft' as const };
    });
  }

  /** §3.3 POST /conversations/{id}/send：分支 A（autoApprove 直发） / 分支 B（审批挂起） */
  async send(
    ctx: OrgScopeContext,
    conversationId: string,
    dto: SendMessageDto,
  ): Promise<SendResult> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const conv = await this.assertConvAccess(tx, ctx, conversationId);

      const [msg] = await tx
        .select()
        .from(schema.message)
        .where(
          and(
            eq(schema.message.id, dto.messageId),
            eq(schema.message.conversationId, conversationId),
          ),
        )
        .limit(1);
      if (!msg) {
        throw new BizException(ErrorCode.NOT_FOUND, '消息不存在');
      }
      if (msg.status === 'sent' || msg.status === 'waiting_approval') {
        throw new BizException(ErrorCode.CONFLICT, '消息已发送或已提交审批，不可重复发送');
      }

      // content 非空则回写最终编辑内容（编辑差异留痕同 PUT）
      let content = msg.content;
      const now = new Date();
      if (
        dto.content !== undefined &&
        dto.content !== null &&
        dto.content.trim().length > 0 &&
        dto.content !== msg.content
      ) {
        content = dto.content;
        await tx
          .update(schema.message)
          .set({
            content,
            editedDiff: [{ field: 'content', before: msg.content, after: content }],
            updatedAt: now,
          })
          .where(eq(schema.message.id, msg.id));
      }

      // 分支判定：org autoApproveTypes 含 'email_send'（当前用户角色审批规则，对齐 Runner 口径）
      const autoApprove = await this.orgAutoApprovesEmailSend(tx, ctx);

      if (autoApprove) {
        // 分支 A：mailbox 驱动真实外发 → sent
        const subject = conv.subject ?? '回复邮件';
        const { externalId } = await sendConversationEmail(
          tx,
          ctx.orgId,
          conversationId,
          subject,
          content,
          this.driverOptions,
        );
        await tx
          .update(schema.message)
          .set({ status: 'sent', sentAt: now, externalMessageId: externalId, updatedAt: now })
          .where(eq(schema.message.id, msg.id));
        // 会话预览刷新
        await tx
          .update(schema.conversation)
          .set({ lastMessageAt: now, lastMessagePreview: content.slice(0, 120), updatedAt: now })
          .where(eq(schema.conversation.id, conversationId));
        return { messageId: msg.id, status: 'sent' as const, sentAt: now.toISOString() };
      }

      // 分支 B：waiting_approval + approval_request（bizType=message，直接消息审批）
      const approvalId = createId('appr');
      const contactName = conv.contactName ?? conv.companyName;
      const subject = conv.subject ?? '（无主题）';
      await tx
        .update(schema.message)
        .set({ status: 'waiting_approval', updatedAt: now })
        .where(eq(schema.message.id, msg.id));
      await tx.insert(schema.approvalRequest).values({
        id: approvalId,
        orgId: ctx.orgId,
        approvalType: 'email_send',
        riskLevel: 'medium',
        title: '邮件发送审核',
        bizType: 'message',
        bizId: msg.id,
        // 12 §1.3 email_send 差异化上下文 + §1.2 卡片字段（contactName/subject/contentPreview）
        context: {
          conversationId,
          customerId: conv.customerId,
          contactName,
          subject,
          contentPreview: content.slice(0, 120),
        },
        aiProposal: { emailContent: content },
        confidence: '0.900',
        reasons: [
          {
            text: '命中审批规则：邮件发送需人工确认',
            evidence: '管理员可在设置中调整自动通过',
            source: 'approval_rule',
          },
          {
            text: '已关联客户与会话上下文',
            evidence: `收件人 ${contactName}`,
            source: 'crm',
          },
        ],
        requestedByUserId: ctx.userId,
        expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
        status: 'pending',
        linkedTaskId: null,
      });

      return {
        messageId: msg.id,
        status: 'draft' as const,
        approval: { approvalId, approvalType: 'email_send' as const, status: 'pending' as const },
      };
    });
  }

  /** §3.5 POST /conversations/{id}/ask-ai：检索客户会话最近消息 + 知识库，拼接回答 */
  async askAi(ctx: OrgScopeContext, conversationId: string, dto: AskAiDto): Promise<AskAiResult> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      await this.assertConvAccess(tx, ctx, conversationId);

      const thread = await this.loadThread(tx, conversationId);
      const kb = await searchKnowledgeChunks(tx, ctx.orgId, {
        query: dto.question,
        scene: 'sales_reply',
        topK: 5,
      });
      const citations: CitationItem[] = kb.results.map((r) => ({
        docId: r.docId,
        docName: r.docName,
        chunkId: r.chunkId,
      }));

      const recent = thread
        .slice(-5)
        .map((m) => `${m.direction === 'in' ? '客户' : '我方'}: ${m.content}`)
        .join('\n');
      const kbLines = kb.results.map((r, i) => `${i + 1}. [${r.docName}] ${r.content}`).join('\n');
      const answer =
        kb.results.length > 0
          ? `问：${dto.question}\n\n会话上下文：\n${recent}\n\n知识库依据：\n${kbLines}`
          : `问：${dto.question}\n\n会话上下文：\n${recent}\n\n知识库暂无相关依据，建议补充资料后重试（D9 兜底，禁止编造）。`;

      return { answer, citations };
    });
  }

  /** §3.4 POST /copilot/suggestions/apply：内容型 insert_draft / 流程型 create_tasks */
  async applySuggestions(
    ctx: OrgScopeContext,
    dto: SuggestionsApplyDto,
  ): Promise<{ draftContent?: string; draftId?: string; taskIds?: string[] }> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const conv = await this.assertConvAccess(tx, ctx, dto.conversationId);

      // 从 conversation_insight.suggestions 取勾选建议 label（不属于本会话 → 42201）
      const [insight] = await tx
        .select({ suggestions: schema.conversationInsight.suggestions })
        .from(schema.conversationInsight)
        .where(eq(schema.conversationInsight.conversationId, dto.conversationId))
        .limit(1);
      const labels = (insight?.suggestions ?? [])
        .filter((s) => dto.suggestionIds.includes(s.suggestionId))
        .map((s) => s.label);
      if (labels.length === 0) {
        throw new BizException(ErrorCode.BIZ_VALIDATION, '勾选建议不存在或不属于本会话');
      }

      if (dto.mode === 'insert_draft') {
        // 返回合并后全文 + 草稿消息 id（新建草稿时前端需回填真实 draftId 才能保存/发送）
        return this.mergeIntoDraft(tx, ctx.orgId, dto.conversationId, labels);
      }

      // create_tasks：为会话所属客户创建 follow_up_task（每客户仅 1 个进行中任务）
      const taskIds = await this.createFollowUpTaskForCustomer(tx, ctx.orgId, conv.customerId);
      return { taskIds };
    });
  }

  // ============================== 写侧 helpers ==============================

  /** 会话级访问校验（40401 不存在 / 40301 self 越权），返回 conv + customer 投影 */
  private async assertConvAccess(
    tx: Tx,
    ctx: OrgScopeContext,
    conversationId: string,
  ): Promise<{
    customerId: string;
    ownerId: string;
    subject: string | null;
    contactName: string | null;
    companyName: string;
  }> {
    const [conv] = await tx
      .select({
        customerId: schema.conversation.customerId,
        subject: schema.conversation.subject,
        ownerId: schema.customer.ownerId,
        companyName: schema.customer.companyName,
        contactName: schema.contact.name,
      })
      .from(schema.conversation)
      .innerJoin(schema.customer, eq(schema.customer.id, schema.conversation.customerId))
      .leftJoin(schema.contact, eq(schema.contact.id, schema.conversation.contactId))
      .where(and(eq(schema.conversation.id, conversationId), notDeleted(schema.customer.deletedAt)))
      .limit(1);
    return assertResourceAccess(conv, ctx);
  }

  /** 消息级访问校验：存在 + org 归属 + 会话客户 owner 越权检查，返回完整行 */
  private async assertMessageAccess(
    tx: Tx,
    ctx: OrgScopeContext,
    messageId: string,
  ): Promise<typeof schema.message.$inferSelect> {
    const [msg] = await tx
      .select()
      .from(schema.message)
      .where(and(eq(schema.message.id, messageId), eq(schema.message.orgId, ctx.orgId)))
      .limit(1);
    if (!msg) {
      throw new BizException(ErrorCode.NOT_FOUND, '消息不存在');
    }
    const [conv] = await tx
      .select({ ownerId: schema.customer.ownerId })
      .from(schema.conversation)
      .innerJoin(schema.customer, eq(schema.customer.id, schema.conversation.customerId))
      .where(eq(schema.conversation.id, msg.conversationId))
      .limit(1);
    assertResourceAccess(conv, ctx);
    return msg;
  }

  private async messageInConversation(
    tx: Tx,
    messageId: string,
    conversationId: string,
  ): Promise<boolean> {
    const [row] = await tx
      .select({ id: schema.message.id })
      .from(schema.message)
      .where(
        and(eq(schema.message.id, messageId), eq(schema.message.conversationId, conversationId)),
      )
      .limit(1);
    return row !== undefined;
  }

  /** 会话时间线（正序，最近 50 条） */
  private async loadThread(
    tx: Tx,
    conversationId: string,
  ): Promise<{ direction: string; content: string; language: string | null }[]> {
    return tx
      .select({
        direction: schema.message.direction,
        content: schema.message.content,
        language: schema.message.language,
      })
      .from(schema.message)
      .where(eq(schema.message.conversationId, conversationId))
      .orderBy(asc(schema.message.createdAt))
      .limit(50);
  }

  /** 语言检测：最近一条 in 消息语言；缺省按内容含中文字符判定 zh/en（06 §7） */
  private detectLanguage(
    thread: { direction: string; language: string | null; content: string }[],
  ): string {
    for (let i = thread.length - 1; i >= 0; i--) {
      const m = thread[i]!;
      if (m.direction === 'in') {
        if (m.language) {
          return m.language;
        }
        return /[\u4e00-\u9fff]/.test(m.content) ? 'zh' : 'en';
      }
    }
    return 'en';
  }

  /** LLM 生成回复草稿（scene=email_reply；红线：无依据参数禁止编造） */
  private async generateReplyDraft(
    ctx: OrgScopeContext,
    thread: { direction: string; content: string }[],
    language: string,
    kb: KnowledgeSearchHit[],
    instruction?: string,
  ): Promise<{ subject: string; body: string; grounded: boolean }> {
    const threadText =
      thread.map((m) => `${m.direction === 'in' ? '客户' : '我方'}: ${m.content}`).join('\n') ||
      '（空会话）';
    const kbText = kb.map((r, i) => `[${i + 1}] ${r.docName}: ${r.content}`).join('\n') || '（无）';
    const { data } = await this.llm.structured(
      { orgId: ctx.orgId, node: 'ai_draft', scene: 'email_reply' },
      draftReplyOutputSchema,
      {
        system:
          '你是外贸销售写手。生成一封回复邮件。红线：业务参数（价格/MOQ/交期/认证）只允许引用知识检索结果；无依据参数时置 grounded=false 并列出 missingInfo，禁止编造。语言跟随 detectedLanguage。',
        user:
          `会话上下文：\n${threadText}\n检测语言：${language}\n知识依据：${kbText}` +
          (instruction ? `\n附加要求：${instruction}` : '') +
          `\n\n请输出 JSON：{ subject, body, grounded, missingInfo? }。`,
      },
    );
    return { subject: data.subject, body: data.body, grounded: data.grounded };
  }

  /** org autoApprove 判定：当前用户角色的 approvalRules 含 email_send 且 autoApprove=true（对齐 Runner 快照口径） */
  private async orgAutoApprovesEmailSend(tx: Tx, ctx: OrgScopeContext): Promise<boolean> {
    const [perm] = await tx
      .select({ approvalRules: schema.rolePermission.approvalRules })
      .from(schema.rolePermission)
      .where(
        and(eq(schema.rolePermission.orgId, ctx.orgId), eq(schema.rolePermission.role, ctx.role)),
      )
      .limit(1);
    return (perm?.approvalRules ?? []).some(
      (r) => r.approvalType === 'email_send' && r.autoApprove === true,
    );
  }

  /** insert_draft：要点合并进当前草稿（无草稿则新建 draft 消息），返回合并后全文 + 草稿 id */
  private async mergeIntoDraft(
    tx: Tx,
    orgId: string,
    conversationId: string,
    labels: string[],
  ): Promise<{ draftContent: string; draftId: string }> {
    const [draft] = await tx
      .select()
      .from(schema.message)
      .where(
        and(
          eq(schema.message.conversationId, conversationId),
          eq(schema.message.direction, 'out'),
          eq(schema.message.status, 'draft'),
        ),
      )
      .orderBy(desc(schema.message.createdAt))
      .limit(1);

    const merged = draft
      ? `${draft.content}\n\n【要点补充】${labels.join('；')}`
      : `【AI 建议要点】\n${labels.join('\n')}`;

    let draftId: string;
    if (draft) {
      draftId = draft.id;
      await tx
        .update(schema.message)
        .set({
          content: merged,
          editedDiff: [{ field: 'content', before: draft.content, after: merged }],
          updatedAt: new Date(),
        })
        .where(eq(schema.message.id, draft.id));
    } else {
      const now = new Date();
      draftId = createId('msg');
      await tx.insert(schema.message).values({
        id: draftId,
        orgId,
        conversationId,
        direction: 'out',
        senderType: 'ai',
        senderName: 'AI 销售助手',
        content: merged,
        language: null,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
      });
    }
    return { draftContent: merged, draftId };
  }

  /** create_tasks：每客户仅 1 个进行中任务（存在则返回既有）；默认策略首步 dayOffset 算 nextRunAt */
  private async createFollowUpTaskForCustomer(
    tx: Tx,
    orgId: string,
    customerId: string,
  ): Promise<string[]> {
    const [active] = await tx
      .select({ id: schema.followUpTask.id })
      .from(schema.followUpTask)
      .where(
        and(
          eq(schema.followUpTask.orgId, orgId),
          eq(schema.followUpTask.customerId, customerId),
          inArray(schema.followUpTask.status, ['ready', 'scheduled', 'waiting_approval']),
        ),
      )
      .limit(1);
    if (active) {
      return [active.id];
    }

    const [strategy] = await tx
      .select()
      .from(schema.followUpStrategy)
      .where(eq(schema.followUpStrategy.orgId, orgId))
      .orderBy(desc(schema.followUpStrategy.isDefault))
      .limit(1);
    if (!strategy) {
      throw new BizException(ErrorCode.BIZ_VALIDATION, '未配置跟进策略，无法创建跟进任务');
    }
    const [firstStep] = await tx
      .select({ dayOffset: schema.followUpStrategyStep.dayOffset })
      .from(schema.followUpStrategyStep)
      .where(eq(schema.followUpStrategyStep.strategyId, strategy.id))
      .orderBy(asc(schema.followUpStrategyStep.seq))
      .limit(1);

    const [orgRow] = await tx
      .select({ timezone: schema.org.timezone, sendRules: schema.org.sendRules })
      .from(schema.org)
      .where(eq(schema.org.id, orgId))
      .limit(1);
    const now = new Date();
    const dayOffset = firstStep?.dayOffset ?? 0;
    const lastOutboundAt = await this.customerLastOutboundAt(tx, customerId);
    const sendRules = orgRow?.sendRules;
    const nextRunAt = computeDeferredNextRunAt({
      now,
      nextRunAt: new Date(now.getTime() + dayOffset * 86_400_000),
      lastOutboundAt,
      minTouchIntervalDays: sendRules?.minTouchIntervalDays ?? 3,
      timeZone: orgRow?.timezone ?? 'Asia/Shanghai',
      ...(sendRules?.sendWindow
        ? {
            window: {
              startHour: Number.parseInt(sendRules.sendWindow.start.slice(0, 2), 10),
              endHour: Number.parseInt(sendRules.sendWindow.end.slice(0, 2), 10),
            },
          }
        : {}),
    });

    const taskId = createId('ftask');
    await tx.insert(schema.followUpTask).values({
      id: taskId,
      orgId,
      customerId,
      strategyId: strategy.id,
      currentStage: 'follow_up_1',
      status: 'ready',
      nextRunAt,
    });
    return [taskId];
  }

  /** 客户维度最近一次已发送 outbound（computeDeferredNextRunAt 频控基准） */
  private async customerLastOutboundAt(tx: Tx, customerId: string): Promise<Date | null> {
    const [lastOut] = await tx
      .select({ sentAt: schema.message.sentAt, createdAt: schema.message.createdAt })
      .from(schema.message)
      .innerJoin(schema.conversation, eq(schema.conversation.id, schema.message.conversationId))
      .where(
        and(
          eq(schema.conversation.customerId, customerId),
          eq(schema.message.direction, 'out'),
          eq(schema.message.status, 'sent'),
        ),
      )
      .orderBy(desc(schema.message.sentAt), desc(schema.message.createdAt))
      .limit(1);
    return lastOut?.sentAt ?? lastOut?.createdAt ?? null;
  }
}
