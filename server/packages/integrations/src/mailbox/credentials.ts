/**
 * 邮箱凭据信封加密与 OAuth token 刷新（后端技术方案 06 §2.4 / 08 §2）：
 * - 凭据以 credential_enc（AES-256-GCM，每行独立 IV，@tradepilot/core crypto）落库；
 * - 解密仅在发送/同步瞬间内存中进行，接口层永不回显明文（16 §3.3）；
 * - OAuth（gmail/outlook）：凭据保存 refresh token，访问 token 按需刷新、不落盘；
 *   刷新失败抛 MailboxAuthError → 上层置 status='disconnected' + 重连入口提示。
 */
import { decryptSecret } from '@tradepilot/core';
import { MailboxAuthError } from './errors.js';
import type { MailboxDriverOptions } from './types.js';

// ===== 信封凭据解密 =====

/** 解密通道凭据；未配置（credential_enc 缺失）返回 null */
export function decryptChannelCredential(
  channel: { credential_enc?: string } | null | undefined,
  encryptionKey: string,
): string | null {
  if (!channel?.credential_enc) {
    return null;
  }
  return decryptSecret(channel.credential_enc, encryptionKey);
}

/** 解密 OAuth refresh token；未配置返回 null */
export function decryptRefreshToken(
  oauth: { refresh_token_enc?: string } | null | undefined,
  encryptionKey: string,
): string | null {
  if (!oauth?.refresh_token_enc) {
    return null;
  }
  return decryptSecret(oauth.refresh_token_enc, encryptionKey);
}

// ===== Gmail OAuth2（googleapis OAuth2 client 承担 access token 刷新）=====
// client 构建收敛在 gmail.ts（动态 import googleapis 后 new google.auth.OAuth2），
// 本文件仅解密 refresh token 与校验客户端凭据配置。

export interface GoogleOAuthClients {
  clientId?: string;
  clientSecret?: string;
}

/** Gmail OAuth2 客户端构建（在 gmail.ts 内动态 import googleapis 后调用） */
export function assertGoogleOAuthConfig(opts: GoogleOAuthClients): void {
  if (!opts.clientId || !opts.clientSecret) {
    throw new MailboxAuthError('Gmail OAuth 客户端凭据未配置（GOOGLE_CLIENT_ID/SECRET）');
  }
}

// ===== Outlook OAuth2（Microsoft identity platform，REST token 端点）=====

export interface MicrosoftOAuthClients {
  clientId?: string;
  clientSecret?: string;
}

/** token 缓存（进程内；到期前 60s 失效重取） */
const msTokenCache = new Map<string, { token: string; expiresAt: number }>();

const MS_TOKEN_TTL_SAFETY_MS = 60_000;

/**
 * 刷新并缓存 Outlook access token（refresh token grant，06 §2.4）。
 * 刷新失败 / 响应缺 token → MailboxAuthError（status='disconnected'）。
 */
export async function getMicrosoftAccessToken(
  refreshToken: string,
  cacheKey: string,
  opts: MicrosoftOAuthClients,
): Promise<string> {
  const cached = msTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }
  if (!opts.clientId || !opts.clientSecret) {
    throw new MailboxAuthError('Outlook OAuth 客户端凭据未配置（MICROSOFT_CLIENT_ID/SECRET）');
  }
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: 'https://graph.microsoft.com/.default offline_access',
  });
  let res: Response;
  try {
    res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      body,
    });
  } catch (err) {
    throw new MailboxAuthError('Outlook token 端点不可达', { cause: err });
  }
  if (!res.ok) {
    throw new MailboxAuthError(`Outlook OAuth 刷新失败（HTTP ${res.status}）`);
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new MailboxAuthError('Outlook OAuth 响应缺少 access_token');
  }
  const ttlMs = (data.expires_in ?? 3600) * 1000 - MS_TOKEN_TTL_SAFETY_MS;
  msTokenCache.set(cacheKey, { token: data.access_token, expiresAt: Date.now() + ttlMs });
  return data.access_token;
}

/** 驱动选项 → OAuth 客户端凭据投影（内部便捷解构） */
export function resolveOAuthClients(options: MailboxDriverOptions): {
  google: GoogleOAuthClients;
  microsoft: MicrosoftOAuthClients;
} {
  return {
    google: {
      clientId: options.oauth?.googleClientId,
      clientSecret: options.oauth?.googleClientSecret,
    },
    microsoft: {
      clientId: options.oauth?.microsoftClientId,
      clientSecret: options.oauth?.microsoftClientSecret,
    },
  };
}
