/**
 * q:notify 消费者——通知分发（M5-A2，后端技术方案 06 §2.3 / 16 FR-09）：
 * 按事件类型映射 notification_setting 事件键 → 读 org 开关矩阵 → 分发：
 * - site 渠道：站内通知表落库（notification；审批待审数另经 GET /approvals/summary 轮询）；
 * - email 渠道：复用 org 任一 connected mailbox 外发系统通知邮件
 *   （收件人 = org 内 active 的 admin/manager，12 §7 审批提醒经理口径）；
 *   无可用邮箱 → 仅站内留痕（06 §2.3 边界）；
 * - webhook 渠道（P1-X-21，06 §5.2）：按 `webhook` 订阅（active）命中事件后派生 `q:webhook` 投递 job，
 *   独立于站内/邮件开关矩阵（订阅本身即开关）。
 * 消费即 ack：本队列任何分发失败只记日志，不抛错（attempts=1，重投无益——通知非关键路径）；
 * 出站投递的失败重试由 q:webhook 自身 attempts=5 承担。
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  createMailboxDriver,
  type MailboxDriverOptions,
  type MailboxDriverRow,
} from '@tradepilot/integrations';
import { schema, withOrg, type Db } from '@tradepilot/db';
import { createId } from '@tradepilot/core';
import {
  DEFAULT_NOTIFICATION_EVENTS,
  notifyEventKey,
  WEBHOOK_STATUS,
  webhookMatchesEvent,
  type NotifyJob,
  type WebhookJob,
  type WebhookPayload,
} from '@tradepilot/shared';

export interface NotifyDeps {
  db: Db;
  logger: Logger;
  driverOptions: MailboxDriverOptions;
  /** q:webhook 入队器（P1-X-21）；缺省 = 未装配 → 订阅命中仅留痕不投递 */
  enqueueWebhook?: (job: WebhookJob) => Promise<void>;
  now?: () => Date;
}

export interface NotifyOutcome {
  orgId: string;
  event: string;
  /** 站内落库是否执行 */
  site: boolean;
  /** email 渠道结果 */
  email: 'sent' | 'skipped' | 'no_mailbox' | 'no_recipients' | 'failed';
  /** 出站 Webhook：命中订阅并成功入队的条数 */
  webhook: number;
}

/** 系统通知邮件收件人角色（审批/风险提醒面向管理者，12 §7） */
const NOTIFY_RECIPIENT_ROLES = ['admin', 'manager'] as const;

export class NotifyProcessor {
  constructor(private readonly deps: NotifyDeps) {}

  async process(payload: NotifyJob): Promise<NotifyOutcome> {
    const event = notifyEventKey(payload.type);
    const now = (this.deps.now ?? (() => new Date()))();

    // 出站 Webhook 先于站内/邮件开关判定（P1-X-21：订阅本身即开关，与 notification_setting 无关）
    const webhook = await this.dispatchWebhooks(payload, event, now);

    // 开关矩阵：缺行回落默认（与 settings ensureNotificationRow 同源兜底）
    const switchMatrix = await withOrg(this.deps.db, payload.orgId, async (tx) => {
      const [row] = await tx
        .select({ events: schema.notificationSetting.events })
        .from(schema.notificationSetting)
        .where(eq(schema.notificationSetting.orgId, payload.orgId))
        .limit(1);
      return row?.events[event] ?? DEFAULT_NOTIFICATION_EVENTS[event];
    });

    if (!switchMatrix.site && !switchMatrix.email) {
      this.deps.logger.info(
        { orgId: payload.orgId, type: payload.type, event, webhook },
        '通知事件站内/邮件双渠道关闭，跳过分发',
      );
      return { orgId: payload.orgId, event, site: false, email: 'skipped', webhook };
    }

    // site 渠道：站内落库（通知主留痕，email 结果回填 email_sent_at）
    const notificationId = switchMatrix.site
      ? await this.insertSiteNotification(payload, event, now)
      : null;

    let email: NotifyOutcome['email'] = 'skipped';
    if (switchMatrix.email) {
      email = await this.sendEmail(payload, notificationId, now);
    }

    return { orgId: payload.orgId, event, site: switchMatrix.site, email, webhook };
  }

  /**
   * 出站 Webhook 派发（06 §5.2）：读 org active 订阅 → 命中事件 → 逐条入队 q:webhook。
   * 单条入队失败只记日志（不阻断其他订阅与站内/邮件渠道）；webhookId 命中唯一，重复入队由 job 名隔离。
   */
  private async dispatchWebhooks(payload: NotifyJob, event: string, now: Date): Promise<number> {
    const enqueue = this.deps.enqueueWebhook;
    const subscriptions = await withOrg(this.deps.db, payload.orgId, async (tx) => {
      return tx
        .select({
          id: schema.webhook.id,
          url: schema.webhook.url,
          events: schema.webhook.events,
        })
        .from(schema.webhook)
        .where(
          and(
            eq(schema.webhook.orgId, payload.orgId),
            eq(schema.webhook.status, WEBHOOK_STATUS.ACTIVE),
          ),
        );
    });
    const matched = subscriptions.filter((sub) =>
      webhookMatchesEvent(sub.events, payload.type, event),
    );
    if (matched.length === 0) {
      return 0;
    }
    if (!enqueue) {
      this.deps.logger.warn(
        { orgId: payload.orgId, type: payload.type, matched: matched.length },
        '命中 Webhook 订阅但入队器未装配（降级留痕，不投递）',
      );
      return 0;
    }

    const webhookPayload: WebhookPayload = {
      event,
      type: payload.type,
      orgId: payload.orgId,
      title: payload.title,
      ...(payload.content !== undefined ? { content: payload.content } : {}),
      ...(payload.refType !== undefined ? { refType: payload.refType } : {}),
      ...(payload.refId !== undefined ? { refId: payload.refId } : {}),
      occurredAt: now.toISOString(),
    };

    let enqueued = 0;
    for (const sub of matched) {
      try {
        await enqueue({
          webhookId: sub.id,
          orgId: payload.orgId,
          url: sub.url,
          payload: webhookPayload,
        });
        enqueued += 1;
      } catch (err: unknown) {
        this.deps.logger.warn(
          {
            orgId: payload.orgId,
            webhookId: sub.id,
            err: err instanceof Error ? err.message : String(err),
          },
          'Webhook 投递入队失败（不影响其他订阅与站内/邮件渠道）',
        );
      }
    }
    return enqueued;
  }

  /** 站内通知落库（返回 id 供 email 结果回填） */
  private async insertSiteNotification(payload: NotifyJob, event: string, now: Date) {
    const notificationId = createId('ntfn');
    await withOrg(this.deps.db, payload.orgId, async (tx) => {
      await tx.insert(schema.notification).values({
        id: notificationId,
        orgId: payload.orgId,
        event,
        title: payload.title,
        content: payload.content ?? null,
        payload: payload as unknown as Record<string, unknown>,
        refType: payload.refType ?? null,
        refId: payload.refId ?? null,
        createdAt: now,
      });
    });
    return notificationId;
  }

  /** email 渠道：org 任一 connected mailbox 外发；结果回填 email_sent_at */
  private async sendEmail(
    payload: NotifyJob,
    notificationId: string | null,
    now: Date,
  ): Promise<NotifyOutcome['email']> {
    const { mailbox, recipients } = await withOrg(this.deps.db, payload.orgId, async (tx) => {
      const [mbx] = await tx
        .select()
        .from(schema.mailbox)
        .where(and(eq(schema.mailbox.orgId, payload.orgId), eq(schema.mailbox.status, 'connected')))
        .orderBy(desc(schema.mailbox.lastSyncAt))
        .limit(1);
      const users = await tx
        .select({ email: schema.userAccount.email })
        .from(schema.userAccount)
        .where(
          and(
            eq(schema.userAccount.orgId, payload.orgId),
            inArray(schema.userAccount.role, [...NOTIFY_RECIPIENT_ROLES]),
            eq(schema.userAccount.status, 'active'),
          ),
        );
      return { mailbox: mbx, recipients: users.map((u) => u.email) };
    });

    if (!mailbox) {
      this.deps.logger.info(
        { orgId: payload.orgId, type: payload.type },
        '无 connected 邮箱，email 渠道降级为仅站内（06 §2.3）',
      );
      return 'no_mailbox';
    }
    if (recipients.length === 0) {
      this.deps.logger.info({ orgId: payload.orgId }, '无 active 管理者收件人，跳过 email 渠道');
      return 'no_recipients';
    }

    try {
      const driver = createMailboxDriver(toDriverRow(mailbox), this.deps.driverOptions);
      await driver.sendMessage({
        from: mailbox.account,
        to: recipients,
        subject: `[TradePilot] ${payload.title}`,
        text: payload.content ?? payload.title,
      });
    } catch (err: unknown) {
      this.deps.logger.warn(
        {
          orgId: payload.orgId,
          type: payload.type,
          err: err instanceof Error ? err.message : String(err),
        },
        '通知邮件发送失败（仅日志留痕，不重投）',
      );
      return 'failed';
    }

    if (notificationId) {
      await withOrg(this.deps.db, payload.orgId, async (tx) => {
        await tx
          .update(schema.notification)
          .set({ emailSentAt: now })
          .where(eq(schema.notification.id, notificationId));
      });
    }
    return 'sent';
  }
}

/** mailbox 行 → 驱动行投影（与 email-sync 同构） */
function toDriverRow(row: typeof schema.mailbox.$inferSelect): MailboxDriverRow {
  return {
    mailboxId: row.id,
    orgId: row.orgId,
    provider: row.provider,
    account: row.account,
    imap: row.imap ?? null,
    smtp: row.smtp ?? null,
    oauth: row.oauth ?? null,
    syncScope: row.syncScope,
  };
}
