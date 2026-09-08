/**
 * Outlook 驱动（后端技术方案 06 §2.1）：Microsoft Graph REST（fetch 直连，避免重 SDK 依赖）。
 * - 收：`/me/mailFolders/{folder}/messages` `$filter=receivedDateTime ge since` 增量；
 *   幂等由 internetMessageId 唯一键兜底（delta 查询游标持久化列 P1）。
 * - 发：`/me/sendMail`。
 * - OAuth2：refresh token grant（credentials.ts），access token 进程内缓存到期刷新；
 *   刷新失败 → MailboxAuthError → 上层置 status='disconnected'。
 */
import { MailboxAuthError, MailboxSendError, isMailboxAuthError } from './errors.js';
import { decryptRefreshToken, getMicrosoftAccessToken, resolveOAuthClients } from './credentials.js';
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

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const API_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 50;

/** 同步文件夹 → Graph folder id 映射（16 §1.5 约定 INBOX/Sent） */
function toGraphFolder(folder: string): string {
  const f = folder.toLowerCase();
  if (f === 'inbox') {
    return 'inbox';
  }
  if (f === 'sent') {
    return 'sentitems';
  }
  return folder;
}

interface GraphContext {
  email: string;
  refreshToken: string;
}

async function buildContext(
  row: MailboxDriverRow,
  options: MailboxDriverOptions,
): Promise<GraphContext> {
  const refreshToken = decryptRefreshToken(row.oauth, options.encryptionKey);
  if (!refreshToken) {
    throw new MailboxAuthError('Outlook OAuth refresh token 未配置');
  }
  return { email: row.account, refreshToken };
}

async function graphFetch<T>(
  ctx: GraphContext,
  options: MailboxDriverOptions,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const cacheKey = `outlook:${ctx.email}`;
  const token = await getMicrosoftAccessToken(
    ctx.refreshToken,
    cacheKey,
    resolveOAuthClients(options).microsoft,
  );
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) {
    throw new MailboxAuthError(`Outlook Graph 授权失败（HTTP ${res.status}）`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new MailboxSendError(`Graph 请求失败（HTTP ${res.status}）: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** Graph message → RawMessage（textPreview / body.content 剥 HTML 兜底） */
function toRawMessage(m: GraphMessage, folder: string): RawMessage | null {
  const externalMessageId = m.internetMessageId?.trim();
  if (!externalMessageId) {
    return null;
  }
  const text =
    (m.uniqueBody?.contentType === 'text' && m.uniqueBody.content.trim()) ||
    (m.body?.contentType === 'text' && m.body.content.trim()) ||
    (m.body?.content ?? '')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const from = m.from?.emailAddress;
  return {
    externalMessageId,
    folder,
    fromName: from?.name ?? null,
    fromEmail: (from?.address ?? '').toLowerCase(),
    toEmails: (m.toRecipients ?? [])
      .map((r) => r.emailAddress.address?.toLowerCase())
      .filter((a): a is string => Boolean(a)),
    subject: m.subject ?? null,
    text,
    date: m.receivedDateTime ? new Date(m.receivedDateTime) : new Date(),
  };
}

interface GraphMessage {
  id: string;
  internetMessageId?: string;
  subject?: string | null;
  receivedDateTime?: string;
  body?: { contentType: string; content: string } | null;
  uniqueBody?: { contentType: string; content: string } | null;
  from?: { emailAddress: { name?: string; address?: string } } | null;
  toRecipients?: { emailAddress: { name?: string; address?: string } }[];
}

export function createOutlookDriver(
  row: MailboxDriverRow,
  options: MailboxDriverOptions,
): MailboxDriver {
  return {
    async testConnection(): Promise<DriverTestResult> {
      try {
        const ctx = await buildContext(row, options);
        await graphFetch<{ displayName?: string }>(ctx, options, '/me');
        return { imap: 'ok', smtp: 'ok' }; // Graph 收发同通道（06 §2.1 表格）
      } catch (err) {
        if (isMailboxAuthError(err)) {
          throw err;
        }
        return { imap: 'fail', smtp: 'fail', error: `Outlook Graph 连接失败: ${errText(err)}` };
      }
    },

    async *syncMessages(params: SyncParams): AsyncIterable<RawMessage> {
      const ctx = await buildContext(row, options);
      for (const folder of params.folders) {
        const graphFolder = toGraphFolder(folder);
        let skip = 0;
        for (;;) {
          const query = new URLSearchParams({
            $select: 'id,internetMessageId,subject,receivedDateTime,body,uniqueBody,from,toRecipients',
            $filter: `receivedDateTime ge ${params.since.toISOString()}`,
            $orderby: 'receivedDateTime asc',
            $top: String(PAGE_SIZE),
            $skip: String(skip),
          });
          const page = await graphFetch<{ value: GraphMessage[] }>(
            ctx,
            options,
            `/me/mailFolders/${graphFolder}/messages?${query.toString()}`,
          );
          for (const m of page.value ?? []) {
            const msg = toRawMessage(m, folder);
            if (msg) {
              yield msg;
            }
          }
          if ((page.value?.length ?? 0) < PAGE_SIZE) {
            break;
          }
          skip += PAGE_SIZE;
        }
      }
    },

    async sendMessage(msg: OutboundMessage): Promise<SendMessageResult> {
      const ctx = await buildContext(row, options);
      try {
        await graphFetch(ctx, options, '/me/sendMail', {
          method: 'POST',
          body: JSON.stringify({
            message: {
              subject: msg.subject,
              body: { contentType: 'text', content: msg.text },
              ...(msg.inReplyTo
                ? { replyTo: [], internetMessageHeaders: [{ name: 'In-Reply-To', value: msg.inReplyTo }] }
                : {}),
              toRecipients: msg.to.map((addr) => ({
                emailAddress: { address: addr },
              })),
            },
            saveToSentItems: 'true',
          }),
        });
        // sendMail 201 无 body：以时间戳形态返回（幂等键兜底在 message 唯一约束之外由任务幂等承担）
        return { externalId: `<outlook-${Date.now()}@${row.account}>` };
      } catch (err) {
        if (isMailboxAuthError(err)) {
          throw err;
        }
        throw new MailboxSendError(`Outlook 发送失败: ${errText(err)}`, { cause: err });
      }
    },
  };
}

function errText(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
