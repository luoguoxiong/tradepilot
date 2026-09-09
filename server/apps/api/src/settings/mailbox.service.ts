import { Inject, Injectable } from '@nestjs/common';
import { and as and_, eq, sql } from 'drizzle-orm';
import { BizException, createId, encryptSecret, ErrorCode } from '@tradepilot/core';
import {
  createMailboxDriver,
  isMailboxAuthError,
  type MailboxDriverOptions,
} from '@tradepilot/integrations';
import { schema, withOrg, type Db, type MailboxChannelConfig, type MailboxOAuthConfig } from '@tradepilot/db';
import { DB } from '../db/db.module.js';
import { EnvService } from '../config/env.service.js';
import { OrgService } from '../org/org.service.js';
import type { CreateMailboxDto, UpdateMailboxDto } from './settings.dto.js';

/**
 * 邮箱连接服务（接口 16 §1.5/§3.3/§3.4 / ER 01 §2.4）：
 * - 凭据 AES-256-GCM 信封加密落库（imap/smtp.credential_enc + oauth.refresh_token_enc，08 §2），
 *   任何响应剥除凭据字段（16 §3.3 永不回显明文）；
 * - 连接测试（M4 #4）：协议级校验——SMTP-IMAP 真实登录、Gmail/Outlook OAuth API 探测（06 §2.1）；
 *   保存前必须通过；凭据失效 → status='disconnected' + 重连入口提示（06 §2.4）；
 * - 创建成功 → onboarding「mailbox」步骤置 done（16 §1.2 联动）。
 */

export interface MailboxView {
  mailboxId: string;
  provider: 'gmail' | 'outlook' | 'smtp_imap';
  account: string;
  imap?: { host: string; port: number; ssl: boolean };
  smtp?: { host: string; port: number; ssl: boolean };
  syncScope: { historyDays: number; folders: string[] };
  status: 'connected' | 'error' | 'disconnected';
}

export interface MailboxTestResult {
  ok: boolean;
  imap?: 'ok' | 'fail';
  smtp?: 'ok' | 'fail';
  error?: string;
}

@Injectable()
export class MailboxService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(EnvService) private readonly env: EnvService,
    @Inject(OrgService) private readonly orgService: OrgService,
  ) {}

  async list(orgId: string): Promise<MailboxView[]> {
    return withOrg(this.db, orgId, async (tx) => {
      const rows = await tx.select().from(schema.mailbox).where(eq(schema.mailbox.orgId, orgId));
      return rows.map(toMailboxView);
    });
  }

  async create(orgId: string, userId: string, dto: CreateMailboxDto): Promise<MailboxView> {
    const account = dto.account.toLowerCase();
    return withOrg(this.db, orgId, async (tx) => {
      const [conflict] = await tx
        .select({ id: schema.mailbox.id })
        .from(schema.mailbox)
        .where(
          and_(eq(schema.mailbox.orgId, orgId), sql`lower(${schema.mailbox.account}) = ${account}`),
        )
        .limit(1);
      if (conflict) {
        throw new BizException(ErrorCode.CONFLICT, '该邮箱已连接');
      }

      const [row] = await tx
        .insert(schema.mailbox)
        .values({
          id: createId('mbx'),
          orgId,
          ownerUserId: userId,
          provider: dto.provider,
          account,
          imap: dto.imap ? toChannelConfig(dto.imap, this.encryptionKey) : undefined,
          smtp: dto.smtp ? toChannelConfig(dto.smtp, this.encryptionKey) : undefined,
          oauth: toOAuthConfig(dto.oauth?.refreshToken, this.encryptionKey),
          syncScope: dto.syncScope,
          status: 'disconnected',
        })
        .returning();
      if (!row) {
        throw new BizException(ErrorCode.INTERNAL, '邮箱连接创建失败');
      }

      // 向导联动（16 §1.2 第 3 步）：连接动作即标记完成（可达性由 test 接口复核）
      await this.orgService.markOnboardingStepDone(orgId, 'mailbox');
      return toMailboxView(row);
    });
  }

  async update(orgId: string, mailboxId: string, dto: UpdateMailboxDto): Promise<MailboxView> {
    return withOrg(this.db, orgId, async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.mailbox)
        .where(and_(eq(schema.mailbox.id, mailboxId), eq(schema.mailbox.orgId, orgId)))
        .limit(1);
      if (!current) {
        throw new BizException(ErrorCode.NOT_FOUND, '邮箱连接不存在');
      }

      // 未传 credential 时保留原密文（凭据与配置可分开更新）
      const imap = dto.imap
        ? toChannelConfig(dto.imap, this.encryptionKey, current.imap)
        : current.imap;
      const smtp = dto.smtp
        ? toChannelConfig(dto.smtp, this.encryptionKey, current.smtp)
        : current.smtp;
      const oauth = dto.oauth?.refreshToken
        ? toOAuthConfig(dto.oauth.refreshToken, this.encryptionKey)
        : current.oauth;

      const [row] = await tx
        .update(schema.mailbox)
        .set({
          imap,
          smtp,
          oauth,
          ...(dto.syncScope !== undefined && { syncScope: dto.syncScope }),
          status: 'disconnected',
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.mailbox.id, mailboxId))
        .returning();
      if (!row) {
        throw new BizException(ErrorCode.NOT_FOUND, '邮箱连接不存在');
      }
      return toMailboxView(row);
    });
  }

  async remove(orgId: string, mailboxId: string): Promise<{ ok: true }> {
    return withOrg(this.db, orgId, async (tx) => {
      const deleted = await tx
        .delete(schema.mailbox)
        .where(and_(eq(schema.mailbox.id, mailboxId), eq(schema.mailbox.orgId, orgId)))
        .returning({ id: schema.mailbox.id });
      if (deleted.length === 0) {
        throw new BizException(ErrorCode.NOT_FOUND, '邮箱连接不存在');
      }
      return { ok: true as const };
    });
  }

  /**
   * 连接测试（16 §3.4，M4 #4 协议级）：经 MailboxDriver 真实校验——
   * smtp_imap = IMAP/SMTP 分别登录；gmail/outlook = OAuth API 探测（06 §2.1）。
   * 凭据失效 → status='disconnected'（重连入口）；其余失败 → 'error'。
   */
  async test(orgId: string, mailboxId: string): Promise<MailboxTestResult> {
    const row = await withOrg(this.db, orgId, async (tx) => {
      const [r] = await tx
        .select()
        .from(schema.mailbox)
        .where(and_(eq(schema.mailbox.id, mailboxId), eq(schema.mailbox.orgId, orgId)))
        .limit(1);
      return r;
    });
    if (!row) {
      throw new BizException(ErrorCode.NOT_FOUND, '邮箱连接不存在');
    }

    let result: MailboxTestResult;
    let authFailed = false;
    try {
      const driverResult = await createMailboxDriver(
        toDriverRow(row),
        this.driverOptions,
      ).testConnection();
      const failed = [driverResult.imap, driverResult.smtp].some((r) => r === 'fail');
      result = {
        ok: !failed && !driverResult.error,
        imap: driverResult.imap,
        smtp: driverResult.smtp,
        error: driverResult.error,
      };
    } catch (err) {
      authFailed = isMailboxAuthError(err);
      const detail = err instanceof Error ? err.message : String(err);
      result = {
        ok: false,
        error: `${authFailed ? '凭据失效或授权过期' : '连接失败'}: ${detail}`.slice(0, 300),
      };
    }

    await withOrg(this.db, orgId, (tx) =>
      tx
        .update(schema.mailbox)
        .set({
          status: result.ok ? 'connected' : authFailed ? 'disconnected' : 'error',
          lastError: result.ok ? null : (result.error ?? '连接失败'),
          updatedAt: new Date(),
        })
        .where(eq(schema.mailbox.id, mailboxId)),
    );
    return result;
  }

  private get encryptionKey(): string {
    return this.env.env.ENCRYPTION_KEY;
  }

  /** 驱动选项（凭据解密 + OAuth 客户端凭据，06 §2.4） */
  private get driverOptions(): MailboxDriverOptions {
    const env = this.env.env;
    return {
      encryptionKey: env.ENCRYPTION_KEY,
      oauth: {
        googleClientId: env.GOOGLE_CLIENT_ID || undefined,
        googleClientSecret: env.GOOGLE_CLIENT_SECRET || undefined,
        microsoftClientId: env.MICROSOFT_CLIENT_ID || undefined,
        microsoftClientSecret: env.MICROSOFT_CLIENT_SECRET || undefined,
      },
    };
  }
}

// ===== helpers =====

type MailboxRow = typeof schema.mailbox.$inferSelect;

/** OAuth 凭据（06 §2.4）：refresh token 信封加密；未传返回 undefined（更新沿用原密文） */
function toOAuthConfig(refreshToken: string | undefined, key: string): MailboxOAuthConfig | undefined {
  if (refreshToken === undefined) {
    return undefined;
  }
  return { refresh_token_enc: encryptSecret(refreshToken, key) };
}

function toChannelConfig(
  input: { host: string; port: number; ssl: boolean; credential?: string },
  key: string,
  previous?: MailboxChannelConfig | null,
): MailboxChannelConfig {
  const credential =
    input.credential !== undefined
      ? encryptSecret(input.credential, key)
      : // 更新未传凭据：沿用原密文（若原通道不存在则该字段缺失，测试时按未配置处理）
        previous?.credential_enc;
  return {
    host: input.host,
    port: input.port,
    ssl: input.ssl,
    ...(credential !== undefined && { credential_enc: credential }),
  };
}

function toMailboxView(m: MailboxRow): MailboxView {
  return {
    mailboxId: m.id,
    provider: m.provider,
    account: m.account,
    ...(m.imap && { imap: { host: m.imap.host, port: m.imap.port, ssl: m.imap.ssl } }),
    ...(m.smtp && { smtp: { host: m.smtp.host, port: m.smtp.port, ssl: m.smtp.ssl } }),
    syncScope: m.syncScope,
    status: m.status,
  };
}

/** db mailbox 行 → 驱动行投影（@tradepilot/integrations 与 db 解耦） */
function toDriverRow(m: MailboxRow): Parameters<typeof createMailboxDriver>[0] {
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
