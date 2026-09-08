/**
 * SMTP-IMAP 驱动（后端技术方案 06 §2.1，16 §2.6 表单 host/port/ssl 凭据）：
 * - 收：imapflow（轮询兜底增量；IDLE 推送 P1）+ mailparser 解析 RFC822 源；
 * - 发：nodemailer SMTP；连接测试分别校验 IMAP / SMTP 登录并回显。
 * 外呼超时：连接 10s / 命令 30s，驱动内配置。
 */
import { ImapFlow } from 'imapflow';
import nodemailer, { type Transporter } from 'nodemailer';
import { MailboxAuthError, MailboxSendError } from './errors.js';
import { decryptChannelCredential } from './credentials.js';
import { parseRawSource } from './mime.js';
import type {
  DriverTestResult,
  MailboxDriver,
  MailboxDriverRow,
  OutboundMessage,
  RawMessage,
  SendMessageResult,
  SyncParams,
} from './types.js';

const CONNECT_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 30_000;

interface ImapConfig {
  host: string;
  port: number;
  ssl: boolean;
  user: string;
  password: string;
}

interface SmtpConfig {
  host: string;
  port: number;
  ssl: boolean;
  user: string;
  password: string;
}

function resolveImapConfig(row: MailboxDriverRow, encryptionKey: string): ImapConfig | null {
  const credential = decryptChannelCredential(row.imap, encryptionKey);
  if (!row.imap?.host || credential === null) {
    return null;
  }
  return {
    host: row.imap.host,
    port: row.imap.port,
    ssl: row.imap.ssl,
    user: row.account,
    password: credential,
  };
}

function resolveSmtpConfig(row: MailboxDriverRow, encryptionKey: string): SmtpConfig | null {
  const credential = decryptChannelCredential(row.smtp, encryptionKey);
  if (!row.smtp?.host || credential === null) {
    return null;
  }
  return {
    host: row.smtp.host,
    port: row.smtp.port,
    ssl: row.smtp.ssl,
    user: row.account,
    password: credential,
  };
}

async function withImap<T>(cfg: ImapConfig, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.ssl,
    auth: { user: cfg.user, pass: cfg.password },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: 2 * COMMAND_TIMEOUT_MS,
    // 拒绝自签证书关闭（企业自建服务器常见）；TLS 指纹校验 P1
    tls: { rejectUnauthorized: false },
    logger: false,
  });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    // logout 失败不影响主流程
    await client.logout().catch(() => undefined);
  }
}

/** RFC822 源 → RawMessage：统一走 mime.ts parseRawSource（驱动共用） */

export function createSmtpImapDriver(
  row: MailboxDriverRow,
  encryptionKey: string,
): MailboxDriver {
  return {
    async testConnection(): Promise<DriverTestResult> {
      const imap = resolveImapConfig(row, encryptionKey);
      const smtp = resolveSmtpConfig(row, encryptionKey);
      const result: DriverTestResult = {};
      if (imap) {
        try {
          await withImap(imap, async () => undefined);
          result.imap = 'ok';
        } catch (err) {
          result.imap = 'fail';
          if (isAuthFailure(err)) {
            throw new MailboxAuthError(`IMAP 认证失败: ${errText(err)}`, { cause: err });
          }
          result.error = `IMAP 连接失败: ${errText(err)}`;
        }
      }
      if (smtp) {
        try {
          const transporter = buildTransporter(smtp);
          await transporter.verify();
          result.smtp = 'ok';
        } catch (err) {
          result.smtp = 'fail';
          if (isAuthFailure(err)) {
            throw new MailboxAuthError(`SMTP 认证失败: ${errText(err)}`, { cause: err });
          }
          result.error = result.error ?? `SMTP 连接失败: ${errText(err)}`;
        }
      }
      if (!imap && !smtp) {
        result.error = 'IMAP/SMTP 主机或凭据未配置';
      }
      return result;
    },

    async *syncMessages(params: SyncParams): AsyncIterable<RawMessage> {
      const imap = resolveImapConfig(row, encryptionKey);
      if (!imap) {
        throw new MailboxAuthError('IMAP 主机或凭据未配置');
      }
      // 生成器内直管连接（yield 必须位于生成器词法体；连接生命周期 = 同步全程）
      const client = new ImapFlow({
        host: imap.host,
        port: imap.port,
        secure: imap.ssl,
        auth: { user: imap.user, pass: imap.password },
        connectionTimeout: CONNECT_TIMEOUT_MS,
        greetingTimeout: CONNECT_TIMEOUT_MS,
        socketTimeout: 2 * COMMAND_TIMEOUT_MS,
        tls: { rejectUnauthorized: false },
        logger: false,
      });
      try {
        await client.connect();
        for (const folder of params.folders) {
          const lock = await client.getMailboxLock(folder).catch(() => null);
          if (!lock) {
            continue; // 文件夹不存在（如未启用 Sent）：跳过
          }
          try {
            // UID + since 增量（06 §2.1 表格）：服务端按内部日期过滤，幂等由 Message-ID 唯一键兜底
            const uids = (await client.search({ since: params.since })) || [];
            for (const uid of uids) {
              const fetched = await client.fetchOne(String(uid), { source: true, envelope: true });
              if (!fetched || !fetched.source) {
                continue;
              }
              const msg = await parseRawSource(
                Buffer.from(fetched.source),
                folder,
                fetched.envelope?.date ?? new Date(),
              );
              if (msg) {
                yield msg;
              }
            }
          } finally {
            lock.release();
          }
        }
      } finally {
        await client.logout().catch(() => undefined);
      }
    },

    async sendMessage(msg: OutboundMessage): Promise<SendMessageResult> {
      const smtp = resolveSmtpConfig(row, encryptionKey);
      if (!smtp) {
        throw new MailboxSendError('SMTP 主机或凭据未配置');
      }
      const transporter = buildTransporter(smtp);
      try {
        const info = await transporter.sendMail({
          from: msg.from,
          to: msg.to.join(', '),
          subject: msg.subject,
          text: msg.text,
          ...(msg.inReplyTo ? { inReplyTo: msg.inReplyTo, references: msg.inReplyTo } : {}),
        });
        // SMTP 无持久 message id 保障：优先响应 messageId，缺省用本地生成形态（幂等键仍兜底）
        return { externalId: info.messageId || `<smtp-${Date.now()}@${smtp.host}>` };
      } catch (err) {
        if (isAuthFailure(err)) {
          throw new MailboxAuthError(`SMTP 认证失败: ${errText(err)}`, { cause: err });
        }
        throw new MailboxSendError(`SMTP 发送失败: ${errText(err)}`, { cause: err });
      } finally {
        transporter.close();
      }
    },

    async markSeen(externalId: string): Promise<void> {
      const imap = resolveImapConfig(row, encryptionKey);
      if (!imap) {
        return;
      }
      await withImap(imap, async (client) => {
        const lock = await client.getMailboxLock('INBOX').catch(() => null);
        if (!lock) {
          return;
        }
        try {
          const uid = (await client.search({ header: { 'message-id': externalId } })) || [];
          const first = uid[0];
          if (first) {
            await client.messageFlagsAdd(String(first), ['\\Seen'], { uid: true });
          }
        } finally {
          lock.release();
        }
      }).catch(() => undefined);
    },
  };
}

function buildTransporter(smtp: SmtpConfig): Transporter {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.ssl,
    auth: { user: smtp.user, pass: smtp.password },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: COMMAND_TIMEOUT_MS,
    tls: { rejectUnauthorized: false },
  });
}

function isAuthFailure(err: unknown): boolean {
  const msg = errText(err).toLowerCase();
  return (
    /auth|login|password|credential|invalid_grant|535|530|authenticationfailed|noauth/.test(msg) ||
    /authentication/.test(msg)
  );
}

function errText(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
