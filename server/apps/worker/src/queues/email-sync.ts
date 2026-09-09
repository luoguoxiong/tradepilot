/**
 * q:email_sync 消费者——收信链路（后端技术方案 06 §2.2，M4 #4）：
 * driver.syncMessages(since) → 逐消息单事务幂等入库：
 *   external_message_id（Message-ID）唯一冲突 → 跳过；
 *   conversation upsert（customer+contact 匹配，未匹配新建轻量线索会话）；
 *   message 插入（direction 按 folder 推断，language 留空由 email_reply 图判定）；
 *   新客户来信 → conversation.unread_count+1、自动 pause 进行中 follow_up_task
 *   + follow_up_execution(skipped, customer_replied)（07 §4）；
 *   销售域询盘来信 → 创建 ai_task(email_reply)（scheduled，Dispatcher 按并发闸门投递）。
 * 出口：更新 mailbox.last_synced_at；凭据失效 → status='disconnected'；
 * 连续失败 ≥3 次 → status='error'（计数存 Redis，无 DDL 侵入）。
 * 附件转存对象存储随 M4 #7（storage 适配器）补齐，本版仅文本正文入库。
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import {
  createMailboxDriver,
  isMailboxAuthError,
  type MailboxDriverOptions,
  type MailboxDriverRow,
  type RawMessage,
} from '@tradepilot/integrations';
import { schema, withOrg, type Db, type Tx } from '@tradepilot/db';
import { createId } from '@tradepilot/core';
import type { Logger } from 'pino';

/** 连续失败熔断阈值（06 §2.2：≥3 次 → status='error'） */
export const SYNC_FAIL_THRESHOLD = 3;
const FAIL_COUNTER_TTL_S = 7 * 24 * 3600;

export interface EmailSyncDeps {
  db: Db;
  redis: Redis;
  logger: Logger;
  driverOptions: MailboxDriverOptions;
  now?: () => Date;
}

export interface SyncOutcome {
  mailboxId: string;
  orgId: string;
  fetched: number;
  ingested: number;
  replyTasksCreated: number;
  status: 'synced' | 'auth_failed' | 'failed' | 'skipped';
  error?: string;
}

export class EmailSyncProcessor {
  constructor(private readonly deps: EmailSyncDeps) {}

  async process(mailboxId: string): Promise<SyncOutcome> {
    const { db, redis, logger } = this.deps;
    const now = (this.deps.now ?? (() => new Date()))();

    // 跨租户定位邮箱（q:email_sync 载荷仅 mailboxId；worker 无用户上下文，sched 白名单）
    const [mailbox] = (await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.sched', '1', true)`);
      return tx.select().from(schema.mailbox).where(eq(schema.mailbox.id, mailboxId)).limit(1);
    })) as (typeof schema.mailbox.$inferSelect)[];
    if (!mailbox) {
      logger.warn({ mailboxId }, '邮箱不存在（已删除），跳过同步');
      return {
        mailboxId,
        orgId: '',
        fetched: 0,
        ingested: 0,
        replyTasksCreated: 0,
        status: 'skipped',
      };
    }

    const driver = createMailboxDriver(toDriverRow(mailbox), this.deps.driverOptions);
    const since =
      mailbox.lastSyncAt ?? new Date(now.getTime() - mailbox.syncScope.historyDays * 24 * 3600_000);

    let fetched = 0;
    let ingested = 0;
    let replyTasksCreated = 0;
    try {
      for await (const raw of driver.syncMessages({
        since,
        folders: mailbox.syncScope.folders,
      })) {
        fetched += 1;
        const result = await this.ingestMessage(mailbox, raw, now);
        if (result.ingested) {
          ingested += 1;
          replyTasksCreated += result.replyTaskCreated ? 1 : 0;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 凭据失效：置 disconnected（重连入口提示，06 §2.4）
      if (isMailboxAuthError(err)) {
        await this.markMailbox(mailbox.orgId, mailbox.id, 'disconnected', message);
        await redis.del(failKey(mailbox.id));
        logger.warn({ mailboxId, err: message }, '邮箱凭据失效，已置 disconnected');
        return {
          mailboxId,
          orgId: mailbox.orgId,
          fetched,
          ingested,
          replyTasksCreated,
          status: 'auth_failed',
          error: message,
        };
      }
      // 连续失败计数（Redis，06 §2.2：≥3 → error + 通知）
      const fails = await redis.incr(failKey(mailbox.id));
      await redis.expire(failKey(mailbox.id), FAIL_COUNTER_TTL_S);
      const status = fails >= SYNC_FAIL_THRESHOLD ? 'error' : mailbox.status;
      await this.markMailbox(mailbox.orgId, mailbox.id, status, message);
      logger.error({ mailboxId, fails, err: message }, '邮箱同步失败（连续失败计数累计）');
      return {
        mailboxId,
        orgId: mailbox.orgId,
        fetched,
        ingested,
        replyTasksCreated,
        status: 'failed',
        error: message,
      };
    }

    // 成功：更新 last_synced_at + 清错误
    await this.markMailbox(mailbox.orgId, mailbox.id, 'connected', null, now);
    await redis.del(failKey(mailbox.id));
    if (fetched > 0) {
      logger.info(
        { mailboxId, orgId: mailbox.orgId, fetched, ingested, replyTasksCreated },
        '邮箱同步完成',
      );
    }
    return {
      mailboxId,
      orgId: mailbox.orgId,
      fetched,
      ingested,
      replyTasksCreated,
      status: 'synced',
    };
  }

  /**
   * 单消息幂等入库（单事务，06 §2.2 / 02 §5）。
   * 返回 { ingested, replyTaskCreated }；幂等冲突（Message-ID 已存在）→ ingested=false。
   */
  async ingestMessage(
    mailbox: typeof schema.mailbox.$inferSelect,
    raw: RawMessage,
    now: Date,
  ): Promise<{ ingested: boolean; replyTaskCreated: boolean }> {
    const orgId = mailbox.orgId;
    const isInbound = !isOwnFolder(raw.folder);

    return withOrg(this.deps.db, orgId, async (tx) => {
      // 幂等：mailboxId + external_message_id 唯一（02 §5 message 幂等键）
      const [existing] = await tx
        .select({ id: schema.message.id })
        .from(schema.message)
        .where(
          and(
            eq(schema.message.mailboxId, mailbox.id),
            eq(schema.message.externalMessageId, raw.externalMessageId),
          ),
        )
        .limit(1);
      if (existing) {
        return { ingested: false, replyTaskCreated: false };
      }

      // ===== 会话对齐：customer + contact 匹配（来信按 from，去信按 to）=====
      const peerEmails = isInbound ? [raw.fromEmail] : raw.toEmails;
      const peerName = raw.fromName;

      let customerRow: { id: string; companyName: string } | null = null;
      let contactId: string | null = null;
      const email = peerEmails.find((e) => e.includes('@'));
      if (email) {
        // ① contact 精确匹配（org 内邮箱唯一索引）
        const [hit] = await tx
          .select({ id: schema.contact.id, customerId: schema.contact.customerId })
          .from(schema.contact)
          .where(
            and(eq(schema.contact.orgId, orgId), sql`lower(${schema.contact.email}) = ${email}`),
          )
          .limit(1);
        if (hit) {
          contactId = hit.id;
          const [c] = await tx
            .select({ id: schema.customer.id, companyName: schema.customer.companyName })
            .from(schema.customer)
            .where(eq(schema.customer.id, hit.customerId))
            .limit(1);
          customerRow = c ?? null;
        }
      }

      // ② 会话复用（customer 维度最新 email 会话）或新建轻量线索会话（06 §2.2）
      let conversationId: string;
      if (customerRow) {
        const [conv] = await tx
          .select({ id: schema.conversation.id })
          .from(schema.conversation)
          .where(
            and(
              eq(schema.conversation.customerId, customerRow.id),
              eq(schema.conversation.channel, 'email'),
            ),
          )
          .orderBy(desc(schema.conversation.lastMessageAt))
          .limit(1);
        conversationId =
          conv?.id ??
          (await createConversation(tx, orgId, customerRow.id, contactId, mailbox, raw, now));
      } else {
        // 未匹配：新建轻量线索 customer + contact（潜在客户，owner=邮箱归属人或首个 active 成员）
        const ownerId = await resolveOwnerUserId(tx, mailbox.ownerUserId);
        const customerId = createId('cus');
        await tx.insert(schema.customer).values({
          id: customerId,
          orgId,
          companyName: deriveCompanyName(peerName, email),
          country: 'Unknown',
          customerType: 'other',
          stage: 'new_lead',
          isFormal: false,
          ownerId,
          remark: '邮件自动建档（未匹配既有客户）',
          createdAt: now,
          updatedAt: now,
        });
        const newContactId = createId('con');
        await tx.insert(schema.contact).values({
          id: newContactId,
          orgId,
          customerId,
          name: peerName || email || '未知联系人',
          title: 'Unknown',
          email: email ?? null,
          isPrimary: true,
          createdAt: now,
          updatedAt: now,
        });
        contactId = newContactId;
        customerRow = { id: customerId, companyName: '' };
        conversationId = await createConversation(tx, orgId, customerId, contactId, mailbox, raw, now);
      }

      // ===== message 插入（direction 按 folder；language 留空由 email_reply 图判定）=====
      const messageId = createId('msg');
      await tx.insert(schema.message).values({
        id: messageId,
        orgId,
        conversationId,
        direction: isInbound ? 'in' : 'out',
        senderType: isInbound ? 'contact' : 'user',
        senderName: peerName || (isInbound ? raw.fromEmail : mailbox.account),
        mailboxId: mailbox.id,
        content: raw.text || raw.subject || '',
        language: null,
        status: 'sent',
        externalMessageId: raw.externalMessageId,
        sentAt: raw.date,
        createdAt: now,
        updatedAt: now,
      });

      // 会话预览 / 未读（仅来信计数，06 §2.2）
      await tx
        .update(schema.conversation)
        .set({
          ...(raw.subject ? { subject: raw.subject } : {}),
          lastMessageAt: raw.date,
          lastMessagePreview: (raw.text || '').slice(0, 120),
          ...(isInbound ? { unreadCount: sql`${schema.conversation.unreadCount} + 1` } : {}),
          updatedAt: now,
        })
        .where(eq(schema.conversation.id, conversationId));

      // ===== 新客户来信副作用（06 §2.2 / 07 §4）=====
      let replyTaskCreated = false;
      if (isInbound && customerRow) {
        const customerId = customerRow.id;
        // 自动 pause 进行中 follow_up_task + skipped 留痕
        const activeTasks = await tx
          .select({ id: schema.followUpTask.id })
          .from(schema.followUpTask)
          .where(
            and(
              eq(schema.followUpTask.customerId, customerId),
              inArray(schema.followUpTask.status, ['ready', 'scheduled', 'waiting_approval']),
            ),
          );
        if (activeTasks.length > 0) {
          await tx
            .update(schema.followUpTask)
            .set({ status: 'paused', updatedAt: now })
            .where(
              inArray(
                schema.followUpTask.id,
                activeTasks.map((t) => t.id),
              ),
            );
          for (const t of activeTasks) {
            await tx.insert(schema.followUpExecution).values({
              id: createId('fexe'),
              orgId,
              followUpTaskId: t.id,
              stepTitle: '客户回复，自动跟进暂停',
              status: 'skipped',
              skipReason: 'customer_replied',
              createdAt: now,
            });
          }
        }

        // 销售域询盘来信（INBOX 新来信）→ email_reply 任务（scheduled，Dispatcher 闸门投递）
        if (raw.folder.toUpperCase() === 'INBOX') {
          replyTaskCreated = await createReplyTask(tx, orgId, customerId, conversationId, messageId, raw, now);
        }
      }

      return { ingested: true, replyTaskCreated };
    });
  }

  private async markMailbox(
    orgId: string,
    mailboxId: string,
    status: 'connected' | 'error' | 'disconnected',
    lastError: string | null,
    at?: Date,
  ): Promise<void> {
    const now = at ?? (this.deps.now ?? (() => new Date()))();
    await withOrg(this.deps.db, orgId, (tx) =>
      tx
        .update(schema.mailbox)
        .set({
          status,
          ...(status === 'connected'
            ? { lastError: null, lastSyncAt: now }
            : { lastError: (lastError ?? '同步失败').slice(0, 500) }),
          updatedAt: now,
        })
        .where(eq(schema.mailbox.id, mailboxId)),
    );
  }
}

// ===== helpers =====

/** Sent 类文件夹 = 本邮箱自身外发存档 */
function isOwnFolder(folder: string): boolean {
  const f = folder.toLowerCase();
  return f === 'sent' || f === 'sentitems' || f === 'sent messages' || f === '已发送';
}

function failKey(mailboxId: string): string {
  return `emailsync:fail:${mailboxId}`;
}

function toDriverRow(mailbox: typeof schema.mailbox.$inferSelect): MailboxDriverRow {
  return {
    mailboxId: mailbox.id,
    orgId: mailbox.orgId,
    provider: mailbox.provider,
    account: mailbox.account,
    imap: mailbox.imap,
    smtp: mailbox.smtp,
    oauth: mailbox.oauth,
    syncScope: mailbox.syncScope,
  };
}

async function createConversation(
  tx: Tx,
  orgId: string,
  customerId: string,
  contactId: string | null,
  mailbox: typeof schema.mailbox.$inferSelect,
  raw: RawMessage,
  now: Date,
): Promise<string> {
  const conversationId = createId('conv');
  await tx.insert(schema.conversation).values({
    id: conversationId,
    orgId,
    customerId,
    ...(contactId ? { contactId } : {}),
    channel: 'email',
    subject: raw.subject ?? null,
    priority: 'pending',
    unreadCount: 0,
    mailboxId: mailbox.id,
    createdAt: now,
    updatedAt: now,
  });
  return conversationId;
}

/** 客户负责人兜底：邮箱归属人 → org 首个 active 成员（customer.owner_id 非空约束） */
async function resolveOwnerUserId(tx: Tx, ownerUserId: string | null): Promise<string> {
  if (ownerUserId) {
    const [u] = await tx
      .select({ id: schema.userAccount.id })
      .from(schema.userAccount)
      .where(and(eq(schema.userAccount.id, ownerUserId), eq(schema.userAccount.status, 'active')))
      .limit(1);
    if (u) {
      return u.id;
    }
  }
  const [fallback] = await tx
    .select({ id: schema.userAccount.id })
    .from(schema.userAccount)
    .where(eq(schema.userAccount.status, 'active'))
    .orderBy(schema.userAccount.createdAt)
    .limit(1);
  if (!fallback) {
    throw new Error('org 无可用成员归属新客户');
  }
  return fallback.id;
}

/** 创建 email_reply 任务：选取具备 email_send 工具的 AI 员工（role=sales 优先） */
async function createReplyTask(
  tx: Tx,
  orgId: string,
  customerId: string,
  conversationId: string,
  inboxMessageId: string,
  raw: RawMessage,
  now: Date,
): Promise<boolean> {
  const employees = await tx
    .select({
      id: schema.aiEmployee.id,
      role: schema.aiEmployee.role,
      tools: schema.aiEmployee.tools,
    })
    .from(schema.aiEmployee)
    .where(eq(schema.aiEmployee.orgId, orgId))
    .limit(50);
  const picked =
    employees.find((e) => e.role === 'sales' && e.tools.includes('email_send')) ??
    employees.find((e) => e.tools.includes('email_send')) ??
    employees.find((e) => e.role === 'sales');
  if (!picked) {
    return false; // org 无可用 AI 销售员工：留待人工处理
  }
  await tx.insert(schema.aiTask).values({
    id: createId('task'),
    orgId,
    employeeId: picked.id,
    type: 'email_reply',
    title: `回复来信：${raw.subject ?? raw.fromEmail}`,
    status: 'scheduled',
    input: { conversationId, customerId, inboxMessageId },
    createdBy: null,
    createdAt: now,
    updatedAt: now,
  });
  return true;
}

/** 公司名推断：显示名 → 邮箱域名主体 */
function deriveCompanyName(name: string | null, email: string | undefined): string {
  if (name && name.trim()) {
    return name.trim().slice(0, 120);
  }
  if (email) {
    const domain = email.split('@')[1];
    if (domain) {
      return domain.replace(/\.(com|net|org|co|io|biz)(\.\w+)?$/i, '').toUpperCase();
    }
  }
  return '未命名客户';
}
