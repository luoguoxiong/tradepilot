import { Inject, Injectable } from '@nestjs/common';
import { and as and_, eq, sql } from 'drizzle-orm';
import * as net from 'node:net';
import { BizException, createId, encryptSecret, ErrorCode } from '@tradepilot/core';
import { schema, withOrg, type Db, type MailboxChannelConfig } from '@tradepilot/db';
import { DB } from '../db/db.module.js';
import { EnvService } from '../config/env.service.js';
import { OrgService } from '../org/org.service.js';
import type { CreateMailboxDto, UpdateMailboxDto } from './settings.dto.js';

/**
 * 邮箱连接服务（接口 16 §1.5/§3.3/§3.4 / ER 01 §2.4）：
 * - 凭据 AES-256-GCM 加密落库（imap/smtp.credential_enc，08 §2），任何响应剥除凭据字段；
 * - 连接测试：M2 阶段做 TCP 可达性探测；协议级验证（IMAP/SMTP 登录、OAuth）随 M4 邮箱驱动落地；
 * - 创建成功 → onboarding「mailbox」步骤置 done（16 §1.2 联动）。
 */

const TCP_TIMEOUT_MS = 3_000;

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

      const [row] = await tx
        .update(schema.mailbox)
        .set({
          imap,
          smtp,
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
   * 连接测试（16 §3.4）：对配置了 host 的通道做 TCP 可达性探测；
   * gmail/outlook OAuth 通道（无 imap/smtp host 配置）M2 记 ok，协议级校验随 M4 驱动。
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

    const [imapResult, smtpResult] = await Promise.all([
      probeChannel(row.imap),
      probeChannel(row.smtp),
    ]);

    const failures = [imapResult, smtpResult].filter((r) => r === 'fail');
    const result: MailboxTestResult = {
      ok: failures.length === 0,
      imap: imapResult,
      smtp: smtpResult,
      ...(failures.length > 0 && { error: 'IMAP/SMTP 连接失败，请检查主机端口与网络可达性' }),
    };

    await withOrg(this.db, orgId, (tx) =>
      tx
        .update(schema.mailbox)
        .set({
          status: result.ok ? 'connected' : 'error',
          lastError: result.ok ? null : result.error,
          updatedAt: new Date(),
        })
        .where(eq(schema.mailbox.id, mailboxId)),
    );
    return result;
  }

  private get encryptionKey(): string {
    return this.env.env.ENCRYPTION_KEY;
  }
}

// ===== helpers =====

type MailboxRow = typeof schema.mailbox.$inferSelect;

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

/** 单通道探测：无 host（OAuth）→ 'ok'（M4 协议级校验兜底）；有 host → TCP 连接探测 */
async function probeChannel(
  channel: MailboxChannelConfig | null | undefined,
): Promise<'ok' | 'fail'> {
  if (!channel || !channel.host) {
    return 'ok';
  }
  return tcpProbe(channel.host, channel.port);
}

function tcpProbe(host: string, port: number): Promise<'ok' | 'fail'> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (r: 'ok' | 'fail'): void => {
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(TCP_TIMEOUT_MS, () => finish('fail'));
    socket.once('connect', () => finish('ok'));
    socket.once('error', () => finish('fail'));
  });
}
