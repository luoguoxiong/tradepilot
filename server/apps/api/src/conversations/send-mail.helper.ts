/**
 * 人工外发唯一出口（06 §2.3 / M5-C1 send 分支 A + 审批批准直发）：
 * 会话关联邮箱（缺省 org 任一 connected 兜底）→ 收件人解析（联系人邮箱 → 兜底最近 in 发件人）→
 * createMailboxDriver 真实驱动 sendMessage。调用方负责 message 行状态落库（sent/failed）。
 * 与 email_send 工具同源语义；人工显式发送不强制窗口/频控（人类操作即明确授权）。
 */
import { and, desc, eq } from 'drizzle-orm';
import { BizException, ErrorCode } from '@tradepilot/core';
import { schema, type Tx } from '@tradepilot/db';
import {
  createMailboxDriver,
  isMailboxAuthError,
  type MailboxDriverOptions,
} from '@tradepilot/integrations';

export interface SendConversationMailResult {
  externalId: string;
  mailboxId: string;
}

/**
 * 经会话关联邮箱真实外发（SMTP/API 驱动），返回驱动产生的 externalId 与所用邮箱。
 * 发送失败 → 50301（依赖服务不可用）；邮箱未连接/无收件人 → 42201。
 */
export async function sendConversationEmail(
  tx: Tx,
  orgId: string,
  conversationId: string,
  subject: string,
  text: string,
  options: MailboxDriverOptions,
): Promise<SendConversationMailResult> {
  const [conv] = await tx
    .select({ mailboxId: schema.conversation.mailboxId, contactId: schema.conversation.contactId })
    .from(schema.conversation)
    .where(eq(schema.conversation.id, conversationId))
    .limit(1);
  if (!conv) {
    throw new BizException(ErrorCode.NOT_FOUND, '会话不存在');
  }

  const mailboxRow = conv.mailboxId
    ? (
        await tx
          .select()
          .from(schema.mailbox)
          .where(and(eq(schema.mailbox.id, conv.mailboxId), eq(schema.mailbox.orgId, orgId)))
          .limit(1)
      )[0]
    : (
        await tx
          .select()
          .from(schema.mailbox)
          .where(and(eq(schema.mailbox.orgId, orgId), eq(schema.mailbox.status, 'connected')))
          .limit(1)
      )[0];
  if (!mailboxRow) {
    throw new BizException(ErrorCode.BIZ_VALIDATION, '无可用邮箱连接，无法外发');
  }
  if (mailboxRow.status === 'disconnected') {
    throw new BizException(ErrorCode.BIZ_VALIDATION, '邮箱已断连，请先重连（06 §2.4）');
  }

  const to = await resolveRecipientEmails(tx, conversationId);
  const driver = createMailboxDriver(
    {
      mailboxId: mailboxRow.id,
      orgId: mailboxRow.orgId,
      provider: mailboxRow.provider,
      account: mailboxRow.account,
      imap: mailboxRow.imap,
      smtp: mailboxRow.smtp,
      oauth: mailboxRow.oauth,
      syncScope: mailboxRow.syncScope,
    },
    options,
  );
  try {
    const sent = await driver.sendMessage({ from: mailboxRow.account, to, subject, text });
    return { externalId: sent.externalId, mailboxId: mailboxRow.id };
  } catch (err) {
    const authFailed = isMailboxAuthError(err);
    const detail = err instanceof Error ? err.message : String(err);
    throw new BizException(
      ErrorCode.DEPENDENCY_UNAVAILABLE,
      `${authFailed ? '邮箱凭据失效或授权过期' : '邮件发送失败'}: ${detail}`,
    );
  }
}

/** 收件人解析：会话关联联系人邮箱 → 兜底最近一封 in 信的发件邮箱（对齐 email_send 工具口径） */
export async function resolveRecipientEmails(tx: Tx, conversationId: string): Promise<string[]> {
  const [conv] = await tx
    .select({ contactId: schema.conversation.contactId })
    .from(schema.conversation)
    .where(eq(schema.conversation.id, conversationId))
    .limit(1);
  if (conv?.contactId) {
    const [c] = await tx
      .select({ email: schema.contact.email })
      .from(schema.contact)
      .where(eq(schema.contact.id, conv.contactId))
      .limit(1);
    if (c?.email) {
      return [c.email.toLowerCase()];
    }
  }
  const [lastIn] = await tx
    .select({ senderName: schema.message.senderName })
    .from(schema.message)
    .where(and(eq(schema.message.conversationId, conversationId), eq(schema.message.direction, 'in')))
    .orderBy(desc(schema.message.createdAt))
    .limit(1);
  const fallback = lastIn?.senderName;
  if (fallback && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fallback)) {
    return [fallback.toLowerCase()];
  }
  throw new BizException(ErrorCode.BIZ_VALIDATION, '会话缺少联系人邮箱，无法外发');
}
