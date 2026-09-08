/**
 * CRM 与邮件读写工具（05 §3）：crm_read / crm_write / email_read / email_send / knowledge_search。
 * M4 #4/#5：email_send 为真实外发唯一出口（06 §2.3）——凭据解密→驱动发送（SMTP/API）→message 行；
 * 窗口+频控校验、失败重试 2 次（指数退避）、最终失败 message.status='failed' + error 日志。
 * AI 权限边界：crm_write 仅写 ai_lead 池与活动记录，不暴露阶段推进/身份/owner 变更（03 §5）。
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, gt, ilike, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { schema, withOrg, type Tx } from '@tradepilot/db';
import { BizException, ErrorCode, createId, getZonedWallTime } from '@tradepilot/core';
import { createMailboxDriver, isMailboxAuthError } from '@tradepilot/integrations';
import { TASK_LOG_TYPE } from '@tradepilot/shared';
import type { ToolContext, ToolDefinition } from '../registry.js';
import { toolIdempotencyKey, withIdempotency, writeToolLog } from '../registry.js';
import { getEmailSendConfig, isEmailSendConfigured } from './email-send-config.js';

const {
  conversation,
  customer,
  contact,
  org,
  mailbox,
  aiLead,
  aiLeadContact,
  customerActivity,
  knowledgeChunk,
  knowledgeDocument,
  message,
} = schema;

// ===== crm_read =====

export const crmReadTool: ToolDefinition<
  { customerId?: string; keyword?: string },
  {
    customers: {
      id: string;
      companyName: string;
      country: string;
      stage: string;
      isFormal: boolean;
      tier: string;
    }[];
  }
> = {
  name: 'crm_read',
  description: '只读查询本 org 客户/联系人/会话（scope=org 全量，AI 不受 user scope 限制但限 org）',
  inputSchema: z.object({
    customerId: z.string().optional(),
    keyword: z.string().optional(),
  }),
  riskLevel: 'low',
  async execute(ctx, input) {
    const conds = [isNull(customer.deletedAt)];
    if (input.customerId) {
      conds.push(eq(customer.id, input.customerId));
    }
    if (input.keyword) {
      conds.push(ilike(customer.companyName, `%${input.keyword}%`));
    }
    const rows = await ctx.tx
      .select({
        id: customer.id,
        companyName: customer.companyName,
        country: customer.country,
        stage: customer.stage,
        isFormal: customer.isFormal,
        score: customer.score,
      })
      .from(customer)
      .where(and(...conds))
      .limit(50);
    await writeToolLog(ctx, TASK_LOG_TYPE.LOOKUP, `查询客户 ${rows.length} 条`);
    return {
      customers: rows.map((r) => ({
        id: r.id,
        companyName: r.companyName,
        country: r.country,
        stage: r.stage,
        isFormal: r.isFormal,
        tier:
          r.score !== null && r.score >= 85
            ? 'high'
            : r.score !== null && r.score >= 60
              ? 'medium'
              : 'low',
      })),
    };
  },
};

// ===== crm_write（仅 ai_lead 池 + 活动记录）=====

export const crmWriteTool: ToolDefinition<
  {
    leads: {
      companyName: string;
      country: string;
      domain?: string;
      website?: string;
      matchPct: number;
      scoreLevel: 'high' | 'medium' | 'low';
      reasons: { text: string; evidence?: string; source?: string }[];
      contacts?: {
        name: string;
        title?: string;
        email?: string;
        decisionInfluencePct?: number | null;
      }[];
    }[];
  },
  { saved: number; merged: number; leadIds: string[] }
> = {
  name: 'crm_write',
  description: '批量写入客户发现池（inCrm=false，不自动进 CRM；加入 CRM 是用户动作，03 §4）',
  inputSchema: z.object({
    // 允许空数组：全部候选被硬过滤/去重排除时零写入收尾（03 §3.6）
    leads: z
      .array(
        z.object({
          companyName: z.string().min(1),
          country: z.string().min(1),
          domain: z.string().optional(),
          website: z.string().optional(),
          matchPct: z.number().int().min(0).max(100),
          scoreLevel: z.enum(['high', 'medium', 'low']),
          reasons: z.array(
            z.object({
              text: z.string(),
              evidence: z.string().optional(),
              source: z.string().optional(),
            }),
          ),
          contacts: z
            .array(
              z.object({
                name: z.string().min(1),
                title: z.string().optional(),
                email: z.string().optional(),
                decisionInfluencePct: z.number().int().min(0).max(100).nullable().optional(),
              }),
            )
            .optional(),
        }),
      )
      .max(50),
  }),
  riskLevel: 'low',
  async execute(ctx, input) {
    let saved = 0;
    let merged = 0;
    const leadIds: string[] = [];
    for (const lead of input.leads) {
      // 三级去重口径：归一化域名优先（03 §3.6）
      const domain = lead.domain?.replace(/^www\./, '').toLowerCase() ?? null;
      const [existing] = domain
        ? await ctx.tx
            .select({ id: aiLead.id, matchPct: aiLead.matchPct })
            .from(aiLead)
            .where(and(eq(aiLead.orgId, ctx.orgId), eq(aiLead.companyDomain, domain)))
            .limit(1)
        : [];
      if (existing) {
        // 跨任务命中未转化 lead → 合并更新（取更高分）
        if (lead.matchPct > existing.matchPct) {
          await ctx.tx
            .update(aiLead)
            .set({
              matchPct: lead.matchPct,
              scoreLevel: lead.scoreLevel,
              insight: { value: lead.matchPct, confidence: 0.8, reasons: lead.reasons },
              analyzedAt: ctx.now,
              taskId: ctx.taskId,
              updatedAt: ctx.now,
            })
            .where(eq(aiLead.id, existing.id));
        }
        merged += 1;
        leadIds.push(existing.id);
        continue;
      }
      const id = createId('lead');
      const inserted = await ctx.tx
        .insert(aiLead)
        .values({
          id,
          orgId: ctx.orgId,
          taskId: ctx.taskId,
          companyName: lead.companyName,
          country: lead.country,
          website: lead.website ?? (domain ? `https://${domain}` : null),
          companyDomain: domain,
          matchPct: lead.matchPct,
          scoreLevel: lead.scoreLevel,
          insight: { value: lead.matchPct, confidence: 0.8, reasons: lead.reasons },
          analyzedAt: ctx.now,
          inCrm: false,
        })
        .returning({ id: aiLead.id });
      const newId = inserted[0]?.id ?? id;
      leadIds.push(newId);
      for (const c of lead.contacts ?? []) {
        await ctx.tx.insert(aiLeadContact).values({
          id: createId('con'),
          orgId: ctx.orgId,
          leadId: newId,
          name: c.name,
          title: c.title ?? null,
          email: c.email?.toLowerCase() ?? null,
          decisionInfluencePct: c.decisionInfluencePct ?? null,
          source: 'ai_discovery',
        });
      }
      saved += 1;
    }
    await writeToolLog(ctx, TASK_LOG_TYPE.FOUND, `发现池写入 ${saved} 条（合并 ${merged} 条）`);
    return { saved, merged, leadIds };
  },
};

// ===== email_read =====

export const emailReadTool: ToolDefinition<
  { conversationId?: string; customerId?: string; inboxMessageId?: string },
  {
    thread: {
      messageId: string;
      direction: 'in' | 'out';
      subject: string | null;
      body: string;
      language: string | null;
      sentAt: string | null;
      senderType: string;
    }[];
    customerId?: string;
  }
> = {
  name: 'email_read',
  description: '读取会话历史与客户上下文（本 org 内只读；同步触发入口）',
  inputSchema: z.object({
    conversationId: z.string().optional(),
    customerId: z.string().optional(),
    inboxMessageId: z.string().optional(),
  }),
  riskLevel: 'low',
  async execute(ctx, input) {
    // 由 messageId → conversation（触发源）或直接给 conversationId/customerId
    let convId = input.conversationId;
    const customerId = input.customerId;
    if (!convId && input.inboxMessageId) {
      const [m] = await ctx.tx
        .select({ conversationId: message.conversationId })
        .from(message)
        .where(eq(message.id, input.inboxMessageId))
        .limit(1);
      convId = m?.conversationId;
    }
    if (!convId && customerId) {
      const [c] = await ctx.tx
        .select({ id: conversation.id })
        .from(conversation)
        .where(and(eq(conversation.customerId, customerId), eq(conversation.channel, 'email')))
        .orderBy(desc(conversation.lastMessageAt))
        .limit(1);
      convId = c?.id;
    }
    if (!convId) {
      return { thread: [], customerId };
    }
    const [conv] = await ctx.tx
      .select({ customerId: conversation.customerId })
      .from(conversation)
      .where(eq(conversation.id, convId))
      .limit(1);
    const rows = await ctx.tx
      .select({
        id: message.id,
        direction: message.direction,
        subject: conversation.subject,
        content: message.content,
        language: message.language,
        sentAt: message.sentAt,
        senderType: message.senderType,
        createdAt: message.createdAt,
      })
      .from(message)
      .innerJoin(conversation, eq(conversation.id, message.conversationId))
      .where(eq(message.conversationId, convId))
      .orderBy(message.createdAt);
    await writeToolLog(ctx, TASK_LOG_TYPE.LOOKUP, `读取会话 ${convId}（${rows.length} 封）`);
    return {
      thread: rows.map((r) => ({
        messageId: r.id,
        direction: r.direction,
        subject: r.subject,
        body: r.content,
        language: r.language,
        sentAt: (r.sentAt ?? r.createdAt)?.toISOString() ?? null,
        senderType: r.senderType,
      })),
      customerId: conv?.customerId ?? customerId,
    };
  },
};

// ===== email_send（真实外发唯一出口，06 §2.3）=====

export interface EmailSendInput {
  conversationId: string;
  subject: string;
  body: string;
  /** 回复语言（email_reply 图透传 detectedLanguage，外发 message.language 落库；06 §7） */
  language?: string;
  /** Break-up Email 标记（强制人工审例外，07 §4） */
  contentKind?: 'initial' | 'value' | 'case' | 'breakup';
  /** reply 模式的触发消息（兼新鲜度基准）；缺省视为 follow_up 模式（基准 = 最近一次 outbound） */
  inboxMessageId?: string;
  customerId?: string;
  mailboxId?: string;
}

export const emailSendTool: ToolDefinition<
  EmailSendInput,
  { messageId: string; externalMessageId: string; status: 'sent'; deduped: boolean }
> = {
  name: 'email_send',
  description:
    '发送邮件（真实外发唯一出口：窗口+频控校验→凭据解密→驱动发送→message 行；幂等键 taskId+nodeId+messageHash）',
  inputSchema: z.object({
    conversationId: z.string().min(1),
    subject: z.string().min(1).max(200),
    body: z.string().min(1),
    language: z.string().max(10).optional(),
    contentKind: z.enum(['initial', 'value', 'case', 'breakup']).optional(),
    inboxMessageId: z.string().optional(),
    customerId: z.string().optional(),
    mailboxId: z.string().optional(),
  }),
  riskLevel: 'medium',
  approvalType: 'email_send',
  /**
   * 新鲜度校验（Runtime §4.7）：批准 resume 后、发送前强制重跑。
   * 仅拦截「客户在基准之后新增的 in 消息」，避免任何历史来信误阻断：
   * - reply 模式（inboxMessageId）：基准 = 触发消息 createdAt（触发消息前的老来信忽略）；
   * - follow_up 模式：基准 = 会话内最近一次已发送 outbound，缺失时回退 conversation.createdAt
   *   （口径对齐 flows.ts check_replied，07 §4）。
   */
  async freshnessCheck(ctx, input) {
    // 模式判定与时间基准：reply（inboxMessageId）= 触发消息；follow_up = 最近一次已发送 outbound
    const trigger = input.inboxMessageId
      ? (
          await ctx.tx
            .select({ createdAt: message.createdAt })
            .from(message)
            .where(eq(message.id, input.inboxMessageId))
            .limit(1)
        )[0]
      : undefined;
    if (input.inboxMessageId && !trigger) {
      // 触发消息已不存在（越权/已清理）：无从判断，交 execute 幂等兜底，保守放行
      return true;
    }
    let since: Date;
    if (trigger) {
      since = trigger.createdAt;
    } else {
      const lastOut = (
        await ctx.tx
          .select({ sentAt: message.sentAt, createdAt: message.createdAt })
          .from(message)
          .where(
            and(
              eq(message.conversationId, input.conversationId),
              eq(message.direction, 'out'),
              eq(message.status, 'sent'),
            ),
          )
          .orderBy(desc(message.createdAt))
          .limit(1)
      )[0];
      const lastOutAt = lastOut?.sentAt ?? lastOut?.createdAt ?? null;
      if (lastOutAt) {
        since = lastOutAt;
      } else {
        // 尚无任何外发：以会话创建为基准（等价 check_replied 的 followUpTask.createdAt 回退）
        const conv = (
          await ctx.tx
            .select({ createdAt: conversation.createdAt })
            .from(conversation)
            .where(eq(conversation.id, input.conversationId))
            .limit(1)
        )[0];
        // 会话不存在：外发注定 FK 失败，保守拦截
        if (!conv) {
          return false;
        }
        since = conv.createdAt;
      }
    }
    const [newerIn] = await ctx.tx
      .select({ id: message.id })
      .from(message)
      .where(
        and(
          eq(message.conversationId, input.conversationId),
          eq(message.direction, 'in'),
          gt(message.createdAt, since),
        ),
      )
      .limit(1);
    return !newerIn;
  },
  async execute(ctx, input) {
    const messageHash = createHash('sha256')
      .update(`${input.subject}\n${input.body}`)
      .digest('hex')
      .slice(0, 16);
    const key = toolIdempotencyKey(ctx, messageHash);
    const { first, result } = await withIdempotency(ctx, key, 24 * 3600, async () => {
      const [conv] = await ctx.tx
        .select({ mailboxId: conversation.mailboxId, customerId: conversation.customerId })
        .from(conversation)
        .where(eq(conversation.id, input.conversationId))
        .limit(1);
      if (!conv) {
        throw new BizException(ErrorCode.NOT_FOUND, `会话不存在: ${input.conversationId}`);
      }

      // mock 兜底（M3 语义）：配置未注入（测试/演练）→ 跳过窗口频控与驱动，直接 mock 外发
      if (!isEmailSendConfigured()) {
        const mockExternalId = `mock-${ctx.taskId}-${ctx.nodeId}-${messageHash}`;
        const inserted = await ctx.tx
          .insert(message)
          .values({
            id: createId('msg'),
            orgId: ctx.orgId,
            conversationId: input.conversationId,
            direction: 'out',
            senderType: 'ai',
            senderName: 'AI 销售员工',
            mailboxId: input.mailboxId ?? conv.mailboxId ?? null,
            content: input.body,
            language: input.language ?? null,
            status: 'sent',
            externalMessageId: mockExternalId,
            sentAt: ctx.now,
            updatedAt: ctx.now,
          })
          .returning({ id: message.id });
        await ctx.tx
          .update(conversation)
          .set({
            lastMessageAt: ctx.now,
            lastMessagePreview: input.body.slice(0, 120),
            updatedAt: ctx.now,
          })
          .where(eq(conversation.id, input.conversationId));
        return {
          messageId: inserted[0]?.id ?? '',
          externalMessageId: mockExternalId,
          status: 'sent' as const,
          deduped: false,
        };
      }

      // 发信唯一出口统一校验：窗口 + 频控（06 §2.3，org.send_rules，04 §3.2）
      await assertSendWindowAndPacing(ctx, conv.customerId);

      // 邮箱解析：入参显式 > 会话关联（会话未关联 → org 任一 connected 兜底，06 §2.3 通知语义同源）
      const mailboxId = input.mailboxId ?? conv.mailboxId;
      const mailboxRow = mailboxId
        ? (
            await ctx.tx
              .select()
              .from(mailbox)
              .where(and(eq(mailbox.id, mailboxId), eq(mailbox.orgId, ctx.orgId)))
              .limit(1)
          )[0]
        : (
            await ctx.tx
              .select()
              .from(mailbox)
              .where(and(eq(mailbox.orgId, ctx.orgId), eq(mailbox.status, 'connected')))
              .limit(1)
          )[0];
      if (!mailboxRow) {
        throw new BizException(ErrorCode.BIZ_VALIDATION, '无可用邮箱连接，无法外发');
      }
      if (mailboxRow.status === 'disconnected') {
        throw new BizException(ErrorCode.BIZ_VALIDATION, '邮箱已断连，请先重连（06 §2.4）');
      }

      const to = await resolveRecipients(ctx, input.conversationId);

      // 真实外发（重试 2 次指数退避；凭据失效不重试，06 §2.3 / §2.4）
      const driver = createMailboxDriver(toDriverRow(mailboxRow), getEmailSendConfig());
      let externalMessageId: string | null = null;
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const sent = await driver.sendMessage({
            from: mailboxRow.account,
            to,
            subject: input.subject,
            text: input.body,
          });
          externalMessageId = sent.externalId;
          break;
        } catch (err) {
          lastError = err;
          if (isMailboxAuthError(err)) {
            break;
          }
          if (attempt < 2) {
            await sleep(attempt === 0 ? 500 : 2_000);
          }
        }
      }
      if (!externalMessageId) {
        const detail = lastError instanceof Error ? lastError.message : String(lastError);
        // 最终失败（06 §2.3）：message.status='failed' + 任务失败语义。
        // failed 行走独立事务落库——本工具节点被 execTool 的 withOrg 单事务包裹，
        // 抛错会连带回滚 ctx.tx 写入；ai_task.error 由 Runner 记录（error 日志同源）。
        await recordFailedMessage(ctx, input, mailboxRow.id);
        throw new BizException(ErrorCode.DEPENDENCY_UNAVAILABLE, `邮件发送失败: ${detail}`);
      }

      const inserted = await ctx.tx
        .insert(message)
        .values({
          id: createId('msg'),
          orgId: ctx.orgId,
          conversationId: input.conversationId,
          direction: 'out',
          senderType: 'ai',
          senderName: 'AI 销售员工',
          mailboxId: mailboxRow.id,
          content: input.body,
          // 语言跟随（06 §7）：图经 inputMap 透传 detectedLanguage；未传（如 follow_up 无语言信号）落 null
          language: input.language ?? null,
          status: 'sent',
          externalMessageId,
          sentAt: ctx.now,
          updatedAt: ctx.now,
        })
        .returning({ id: message.id });
      const messageId = inserted[0]?.id ?? '';
      // 会话预览刷新
      await ctx.tx
        .update(conversation)
        .set({
          lastMessageAt: ctx.now,
          lastMessagePreview: input.body.slice(0, 120),
          updatedAt: ctx.now,
        })
        .where(eq(conversation.id, input.conversationId));
      return { messageId, externalMessageId, status: 'sent' as const, deduped: false };
    });
    if (!first) {
      await writeToolLog(ctx, TASK_LOG_TYPE.ERROR, 'email_send 幂等命中：跳过重复外发');
      return {
        ...result,
        deduped: true,
        messageId: result.messageId || '',
        externalMessageId: result.externalMessageId || '',
      };
    }
    await writeToolLog(ctx, TASK_LOG_TYPE.FOUND, `邮件已发送：${input.subject}`);
    return result;
  },
};

// ===== knowledge_search（M3 ILIKE 骨架；pgvector+pg_trgm+RRF 混合检索随 M4）=====

export const knowledgeSearchTool: ToolDefinition<
  { query: string; scene?: string; topK?: number },
  {
    chunks: {
      chunkId: string;
      documentId: string;
      title: string;
      category: string;
      excerpt: string;
    }[];
  }
> = {
  name: 'knowledge_search',
  description: '知识库检索（按 knowledge_scope 过滤；业务参数唯一结构化来源，06 §4）',
  inputSchema: z.object({
    query: z.string().min(1),
    scene: z.string().optional(),
    topK: z.number().int().min(1).max(20).optional(),
  }),
  riskLevel: 'low',
  async execute(ctx, input) {
    const rows = await ctx.tx
      .select({
        chunkId: knowledgeChunk.id,
        documentId: knowledgeDocument.id,
        title: knowledgeDocument.fileName,
        category: knowledgeDocument.category,
        content: knowledgeChunk.content,
      })
      .from(knowledgeChunk)
      .innerJoin(knowledgeDocument, eq(knowledgeDocument.id, knowledgeChunk.documentId))
      .where(
        and(ilike(knowledgeChunk.content, `%${input.query}%`), isNull(knowledgeDocument.deletedAt)),
      )
      .limit(input.topK ?? 5);
    return {
      chunks: rows.map((r) => ({
        chunkId: r.chunkId,
        documentId: r.documentId,
        title: r.title,
        category: r.category,
        excerpt: r.content.slice(0, 200),
      })),
    };
  },
};

// ===== email_send 辅助 =====

/** 失败留痕（独立事务，随抛错存活；06 §2.3）：无独立连接时降级为仅任务错误可见 */
async function recordFailedMessage(
  ctx: ToolContext,
  input: EmailSendInput,
  mailboxId: string,
): Promise<void> {
  const { db } = getEmailSendConfig();
  const write = (tx: Tx) =>
    tx.insert(message).values({
      id: createId('msg'),
      orgId: ctx.orgId,
      conversationId: input.conversationId,
      direction: 'out',
      senderType: 'ai',
      senderName: 'AI 销售员工',
      mailboxId,
      content: input.body,
      language: input.language ?? null,
      status: 'failed',
      sentAt: ctx.now,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    });
  if (db) {
    await withOrg(db, ctx.orgId, write);
  }
}

/**
 * 发信唯一出口校验（06 §2.3）：org.send_rules 窗口（org.timezone 墙钟）+ 客户维度最小触达间隔。
 * 违反 → RATE_LIMITED（42901，任务失败可重试；follow_up 主链路由 Scheduler 预检顺延，此处为兜底）。
 */
async function assertSendWindowAndPacing(ctx: ToolContext, customerId: string | null): Promise<void> {
  const [orgRow] = await ctx.tx.select().from(org).where(eq(org.id, ctx.orgId)).limit(1);
  if (!orgRow) {
    return; // org 行缺失极端场景：交由外层业务约束兜底
  }
  // ① 发送窗口（FR-12：sendWindow { start, end } 'HH:MM'；timezone 缺省回落 UTC）
  const sendWindow = orgRow.sendRules?.sendWindow;
  if (sendWindow && orgRow.timezone) {
    const startHour = Number.parseInt(sendWindow.start.slice(0, 2), 10);
    const endHour = Number.parseInt(sendWindow.end.slice(0, 2), 10);
    if (!Number.isNaN(startHour) && !Number.isNaN(endHour)) {
      const wall = getZonedWallTime(ctx.now, orgRow.timezone);
      if (wall.hour < startHour || wall.hour >= endHour) {
        throw new BizException(
          ErrorCode.RATE_LIMITED,
          `当前不在发送窗口（${sendWindow.start}~${sendWindow.end} ${orgRow.timezone}）内`,
        );
      }
    }
  }
  // ② 最小触达间隔：客户维度最近一次已发送 outbound + minTouchIntervalDays（07 §7）
  const intervalDays = orgRow.sendRules?.minTouchIntervalDays ?? 0;
  if (intervalDays <= 0 || !customerId) {
    return;
  }
  const [lastOut] = await ctx.tx
    .select({ sentAt: message.sentAt, createdAt: message.createdAt })
    .from(message)
    .innerJoin(conversation, eq(conversation.id, message.conversationId))
    .where(
      and(
        eq(conversation.customerId, customerId),
        eq(message.direction, 'out'),
        eq(message.status, 'sent'),
      ),
    )
    .orderBy(desc(message.sentAt), desc(message.createdAt))
    .limit(1);
  const lastAt = lastOut?.sentAt ?? lastOut?.createdAt ?? null;
  if (lastAt) {
    const earliest = lastAt.getTime() + intervalDays * 24 * 3600_000;
    if (ctx.now.getTime() < earliest) {
      throw new BizException(
        ErrorCode.RATE_LIMITED,
        `客户最小触达间隔 ${intervalDays} 天内，禁止再次外发（07 §7 频控）`,
      );
    }
  }
}

/** 收件人解析：会话关联联系人邮箱 → 兜底最近一封 in 信的发件邮箱 */
async function resolveRecipients(ctx: ToolContext, conversationId: string): Promise<string[]> {
  const [conv] = await ctx.tx
    .select({ contactId: conversation.contactId })
    .from(conversation)
    .where(eq(conversation.id, conversationId))
    .limit(1);
  if (conv?.contactId) {
    const [c] = await ctx.tx
      .select({ email: contact.email })
      .from(contact)
      .where(eq(contact.id, conv.contactId))
      .limit(1);
    if (c?.email) {
      return [c.email.toLowerCase()];
    }
  }
  const [lastIn] = await ctx.tx
    .select({ senderName: message.senderName })
    .from(message)
    .where(and(eq(message.conversationId, conversationId), eq(message.direction, 'in')))
    .orderBy(desc(message.createdAt))
    .limit(1);
  const fallback = lastIn?.senderName;
  if (fallback && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fallback)) {
    return [fallback.toLowerCase()];
  }
  throw new BizException(ErrorCode.BIZ_VALIDATION, '会话缺少联系人邮箱，无法外发');
}

function toDriverRow(m: typeof mailbox.$inferSelect): Parameters<typeof createMailboxDriver>[0] {
  return {
    mailboxId: m.id,
    orgId: m.orgId,
    provider: m.provider,
    account: m.account,
    imap: m.imap,
    smtp: m.smtp,
    oauth: m.oauth,
    syncScope: m.syncScope,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===== 客户活动记录（writeback 类工具共用）=====

export async function writeCustomerActivity(
  ctx: ToolContext,
  customerId: string,
  summary: string,
  refType?: string,
  refId?: string,
): Promise<void> {
  await ctx.tx.insert(customerActivity).values({
    id: createId('act'),
    orgId: ctx.orgId,
    customerId,
    type: 'ai_action',
    summary,
    operatorType: 'ai',
    operatorId: ctx.employeeId,
    operatorName: 'AI 员工',
    refType: refType ?? null,
    refId: refId ?? null,
  });
}

export function registerCrmTools(register: (t: ToolDefinition) => void): void {
  register(crmReadTool);
  register(crmWriteTool);
  register(emailReadTool);
  register(emailSendTool);
  register(knowledgeSearchTool);
}
