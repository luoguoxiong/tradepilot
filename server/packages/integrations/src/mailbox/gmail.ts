/**
 * Gmail 驱动（后端技术方案 06 §2.1）：
 * - 收：Gmail API `users.messages.list`（after 日期增量 + labelIds 文件夹映射），
 *   拉取 raw RFC822 源后与 SMTP-IMAP 驱动共用 mailparser 解析；
 *   幂等由 Message-ID 唯一键兜底（historyId 游标持久化列 P1，当前以日期粒度回扫 + 去重）。
 * - 发：Gmail API `users.messages.send`（MIME raw）。
 * - OAuth2：refresh token 存凭据（信封加密），googleapis client 自动刷新 access token；
 *   刷新失败 → MailboxAuthError → 上层置 status='disconnected'。
 */
import type { gmail_v1 } from 'googleapis';
import { MailboxAuthError, MailboxSendError, isMailboxAuthError } from './errors.js';
import { assertGoogleOAuthConfig, decryptRefreshToken, resolveOAuthClients } from './credentials.js';
import { parseRawSource } from './mime.js';
import type {
  DriverTestResult,
  MailboxDriver,
  MailboxDriverOptions,
  MailboxDriverRow,
  OutboundMessage,
  RawMessage,
  SendMessageResult,
  SyncParams,
} from './types.js';

const API_TIMEOUT_MS = 30_000;

/** 同步文件夹 → Gmail label 映射（16 §1.5 folders 约定 INBOX/Sent） */
function toGmailLabel(folder: string): string {
  const f = folder.toLowerCase();
  if (f === 'inbox') {
    return 'INBOX';
  }
  if (f === 'sent') {
    return 'SENT';
  }
  return folder;
}

/** gmail driver 上下文（延迟构建，避免非 OAuth 链路加载 googleapis） */
interface GmailContext {
  gmail: gmail_v1.Gmail;
  email: string;
}

async function buildContext(
  row: MailboxDriverRow,
  options: MailboxDriverOptions,
): Promise<GmailContext> {
  const refreshToken = decryptRefreshToken(row.oauth, options.encryptionKey);
  if (!refreshToken) {
    throw new MailboxAuthError('Gmail OAuth refresh token 未配置');
  }
  const googleClients = resolveOAuthClients(options).google;
  assertGoogleOAuthConfig(googleClients);
  const { google } = await import('googleapis');
  const client = new google.auth.OAuth2(googleClients.clientId, googleClients.clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  const gmail = google.gmail({ version: 'v1', auth: client, timeout: API_TIMEOUT_MS });
  return { gmail, email: row.account };
}

/** base64url（Gmail raw）→ Buffer */
function fromBase64Url(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function createGmailDriver(
  row: MailboxDriverRow,
  options: MailboxDriverOptions,
): MailboxDriver {
  return {
    async testConnection(): Promise<DriverTestResult> {
      try {
        const ctx = await buildContext(row, options);
        await ctx.gmail.users.getProfile({ userId: 'me' });
        return { imap: 'ok', smtp: 'ok' }; // Gmail API 收发同通道（06 §2.1 表格）
      } catch (err) {
        if (isMailboxAuthError(err)) {
          throw err;
        }
        return { imap: 'fail', smtp: 'fail', error: `Gmail API 连接失败: ${errText(err)}` };
      }
    },

    async *syncMessages(params: SyncParams): AsyncIterable<RawMessage> {
      const ctx = await buildContext(row, options);
      // after 采用日期粒度（Gmail 查询语法）；重复拉取由 message 唯一键幂等去重
      const after = `after:${Math.floor(params.since.getTime() / 1000)}`;
      for (const folder of params.folders) {
        const label = toGmailLabel(folder);
        let pageToken: string | undefined;
        do {
          const list = await ctx.gmail.users.messages.list({
            userId: 'me',
            q: after,
            labelIds: [label],
            maxResults: 50,
            ...(pageToken ? { pageToken } : {}),
          });
          pageToken = (list.data as { nextPageToken?: string }).nextPageToken;
          for (const item of list.data.messages ?? []) {
            if (!item.id) {
              continue;
            }
            const full = await ctx.gmail.users.messages.get({
              userId: 'me',
              id: item.id,
              format: 'raw',
            });
            if (!full.data.raw) {
              continue;
            }
            const msg = await parseRawSource(fromBase64Url(full.data.raw), folder, new Date());
            if (msg) {
              yield msg;
            }
          }
        } while (pageToken);
      }
    },

    async sendMessage(msg: OutboundMessage): Promise<SendMessageResult> {
      const ctx = await buildContext(row, options);
      const mime = buildMime(msg);
      try {
        const res = await ctx.gmail.users.messages.send({
          userId: 'me',
          requestBody: { raw: mime.toString('base64').replace(/\+/g, '-').replace(/\//g, '_') },
        });
        return { externalId: res.data.id ?? `<gmail-${Date.now()}@${row.account}>` };
      } catch (err) {
        if (isMailboxAuthError(err)) {
          throw err;
        }
        throw new MailboxSendError(`Gmail 发送失败: ${errText(err)}`, { cause: err });
      }
    },

    async markSeen(externalId: string): Promise<void> {
      const ctx = await buildContext(row, options);
      const list = await ctx.gmail.users.messages.list({
        userId: 'me',
        q: `rfc822msgid:${externalId}`,
        maxResults: 1,
      });
      const id = list.data.messages?.[0]?.id;
      if (id) {
        await ctx.gmail.users.messages
          .modify({ userId: 'me', id, requestBody: { addLabelIds: [], removeLabelIds: ['UNREAD'] } })
          .catch(() => undefined);
      }
    },
  };
}

/** 最小 RFC5322 MIME 组装（纯文本；无附件） */
function buildMime(msg: OutboundMessage): Buffer {
  const headers = [
    `From: ${msg.from}`,
    `To: ${msg.to.join(', ')}`,
    `Subject: =?UTF-8?B?${Buffer.from(msg.subject, 'utf8').toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    ...(msg.inReplyTo ? [`In-Reply-To: ${msg.inReplyTo}`, `References: ${msg.inReplyTo}`] : []),
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <tp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@tradepilot.local>`,
  ];
  const body = Buffer.from(msg.text, 'utf8').toString('base64');
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'utf8');
}

function errText(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
