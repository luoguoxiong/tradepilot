import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { BizException, createId, decryptSecret } from '@tradepilot/core';
import { closeDb, createDb, schema, type Db } from '@tradepilot/db';
import { EnvService } from '../src/config/env.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { TokenService } from '../src/auth/token.service.js';
import { OrgService } from '../src/org/org.service.js';
import { MailboxService } from '../src/settings/mailbox.service.js';
import { SettingsService } from '../src/settings/settings.service.js';
import { updateOrgSchema } from '../src/org/org.dto.js';
import { rolePermissionsSchema } from '../src/settings/settings.dto.js';
import { testMail } from './setup/providers.js';

/**
 * M2 任务 8/9 集成测试（org onboarding / 成员邀请 / 16 设置 P0 接口）。
 * 前置：docker compose up（PG 5432 / Redis / GreenMail 1025+1114）+ 迁移已执行 + tradepilot_app 角色存在，
 * 且已提供 server/.env.test（真实 provider 配置，无 mock 兜底）。
 * - 引导/清理用超级用户（BYPASSRLS）
 * - 业务断言用 tradepilot_app 连接（FORCE RLS）
 */

process.env.JWT_SECRET ||= 'it_only_test_secret_0123456789abcdef0123456789abcdef';
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.REDIS_URL ||= 'redis://localhost:6380';
process.env.DATABASE_URL ||= 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';

const SUPER_URL = 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';
const APP_URL = 'postgresql://tradepilot_app:changeme_app@localhost:5432/tradepilot';

let superDb: Db;
let appDb: Db;
let redis: Redis;
let auth: AuthService;
let orgService: OrgService;
let mailboxService: MailboxService;
let settings: SettingsService;

// 会话内共享状态（用例按序依赖）
let orgId = '';
let adminId = '';
const adminEmail = `it-admin-${createId('org')}@test.com`;

/** 期望抛 BizException 并返回错误码 */
async function expectBizError(p: Promise<unknown>, code: number): Promise<void> {
  try {
    await p;
    expect.fail(`应抛出错误码 ${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(BizException);
    expect((e as BizException).code).toBe(code);
  }
}

beforeAll(async () => {
  superDb = createDb(SUPER_URL, { max: 2 });
  appDb = createDb(APP_URL, { max: 5 });
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
  const env = new EnvService();
  const tokens = new TokenService(env, redis);
  auth = new AuthService(appDb, tokens, redis);
  orgService = new OrgService(appDb, redis);
  settings = new SettingsService(appDb);
  mailboxService = new MailboxService(appDb, env, orgService);

  // 注册企业（register 全链路：org + admin + 种子，03 §1.1）
  const session = await auth.register({
    companyName: 'IT 设置测试租户',
    contactName: '管理员',
    email: adminEmail,
    password: 'password123',
  });
  orgId = session.user.orgId;
  adminId = session.user.userId;
}, 30_000);

afterAll(async () => {
  if (orgId) {
    await superDb.transaction(async (tx) => {
      await tx.delete(schema.mailbox).where(eq(schema.mailbox.orgId, orgId));
      await tx
        .delete(schema.notificationSetting)
        .where(eq(schema.notificationSetting.orgId, orgId));
      await tx.delete(schema.aiModelSetting).where(eq(schema.aiModelSetting.orgId, orgId));
      await tx
        .delete(schema.followUpStrategyStep)
        .where(eq(schema.followUpStrategyStep.orgId, orgId));
      await tx.delete(schema.followUpStrategy).where(eq(schema.followUpStrategy.orgId, orgId));
      await tx.delete(schema.aiEmployee).where(eq(schema.aiEmployee.orgId, orgId));
      await tx.delete(schema.sopTemplate).where(eq(schema.sopTemplate.orgId, orgId));
      await tx.delete(schema.rolePermission).where(eq(schema.rolePermission.orgId, orgId));
      await tx.delete(schema.userAccount).where(eq(schema.userAccount.orgId, orgId));
      await tx.delete(schema.org).where(eq(schema.org.id, orgId));
    });
  }
  await redis.quit();
  await closeDb(appDb);
  await closeDb(superDb);
});

describe('onboarding 断点续走（16 §1.2）', () => {
  it('注册后默认 currentStep=1，steps 按步骤推导', async () => {
    const status = await orgService.getOnboarding(orgId);
    expect(status.currentStep).toBe(1);
    expect(status.steps.map((s) => s.key)).toEqual(['company', 'products', 'mailbox', 'done']);
    expect(status.steps[0]?.done).toBe(false);
    expect(status.steps[3]?.done).toBe(false);
  });

  it('PUT currentStep=2 持久化；步骤完成标记保留', async () => {
    await orgService.markOnboardingStepDone(orgId, 'company');
    const after = await orgService.updateOnboarding(orgId, 2);
    expect(after.currentStep).toBe(2);
    const status = await orgService.getOnboarding(orgId);
    expect(status.steps.find((s) => s.key === 'company')?.done).toBe(true);
  });
});

describe('企业信息 GET/PUT（16 §1.3）', () => {
  it('本地化三默认值 + 外发规则往返（扁平 sendRules ↔ jsonb sendWindow）', async () => {
    const updated = await orgService.updateOrg(orgId, {
      timezone: 'America/New_York',
      defaultCurrency: 'EUR',
      defaultLanguage: 'en',
      sendRules: { timeWindowStart: '08:30', timeWindowEnd: '17:30', minTouchIntervalDays: 2 },
    });
    expect(updated).toMatchObject({
      timezone: 'America/New_York',
      defaultCurrency: 'EUR',
      defaultLanguage: 'en',
      sendRules: { timeWindowStart: '08:30', timeWindowEnd: '17:30', minTouchIntervalDays: 2 },
    });
    const profile = await orgService.getOrg(orgId);
    expect(profile.sendRules?.minTouchIntervalDays).toBe(2);
  });

  it('sendRules 缺省字段回退默认窗口（07 §7.3）', async () => {
    await orgService.updateOrg(orgId, { sendRules: { minTouchIntervalDays: 5 } });
    const profile = await orgService.getOrg(orgId);
    expect(profile.sendRules).toMatchObject({
      timeWindowStart: '09:00',
      timeWindowEnd: '18:00',
      minTouchIntervalDays: 5,
    });
  });

  it('DTO 层校验：窗口起点需早于终点 / IANA 时区', () => {
    const badWindow = updateOrgSchema.safeParse({
      sendRules: { timeWindowStart: '18:00', timeWindowEnd: '09:00' },
    });
    expect(badWindow.success).toBe(false);
    const badTz = updateOrgSchema.safeParse({ timezone: 'Not/AZone' });
    expect(badTz.success).toBe(false);
    const ok = updateOrgSchema.safeParse({ timezone: 'Asia/Shanghai' });
    expect(ok.success).toBe(true);
  });
});

describe('成员邀请与生命周期（16 §1.4 / 03 §6）', () => {
  let inviteToken = '';
  // createId 含大写字符；服务端统一小写存储，测试邮箱同样小写化
  const inviteeEmail = `it-invitee-${adminEmail.split('@')[0].toLowerCase()}@test.com`;

  it('邀请：创建 invited 占位成员 + 单次邀请 token', async () => {
    const { inviteToken: token, ...member } = await orgService.inviteMember(orgId, adminId, {
      email: inviteeEmail,
      role: 'sales',
    });
    inviteToken = token;
    expect(member.status).toBe('invited');
    expect(member.role).toBe('sales');
    expect(token.length).toBeGreaterThan(20);
    expect(await redis.get(`invite:${token}`)).not.toBeNull();
  });

  it('同邮箱重复邀请 → 40901', async () => {
    await expectBizError(
      orgService.inviteMember(orgId, adminId, { email: inviteeEmail, role: 'sales' }),
      40901,
    );
  });

  it('接受邀请：invited → active，token 单次消费', async () => {
    const session = await auth.acceptInvitation({
      token: inviteToken,
      name: '受邀成员',
      password: 'invited-pass-1',
    });
    expect(session.user.role).toBe('sales');
    // token 已消费
    await expectBizError(
      auth.acceptInvitation({ token: inviteToken, name: 'x', password: 'invited-pass-1' }),
      40401,
    );
    const members = await orgService.listMembers(orgId);
    const invitee = members.find((m) => m.email === inviteeEmail);
    expect(invitee?.status).toBe('active');
    expect(invitee?.joinedAt).not.toBeNull();
  });

  it('角色变更生效；最后一名管理员不可降级 → 42201', async () => {
    const members = await orgService.listMembers(orgId);
    const invitee = members.find((m) => m.email === inviteeEmail);
    await orgService.updateMember(orgId, invitee!.memberId, { role: 'manager' });
    await expectBizError(orgService.updateMember(orgId, adminId, { role: 'sales' }), 42201);
    await expectBizError(orgService.updateMember(orgId, adminId, { status: 'disabled' }), 42201);
  });

  it('停用即时失效（disabled 标记）→ 启用清除', async () => {
    const members = await orgService.listMembers(orgId);
    const invitee = members.find((m) => m.email === inviteeEmail);
    await orgService.updateMember(orgId, invitee!.memberId, { status: 'disabled' });
    expect(await redis.get(`disabled:${invitee!.memberId}`)).not.toBeNull();
    await orgService.updateMember(orgId, invitee!.memberId, { status: 'active' });
    expect(await redis.get(`disabled:${invitee!.memberId}`)).toBeNull();
  });
});

describe('邮箱连接（16 §1.5/§3.3/§3.4）', () => {
  let mailboxId = '';
  const account = `it-mbx-${adminEmail}`;

  it('创建：凭据 AES-256-GCM 加密落库，响应永不回显', async () => {
    const view = await mailboxService.create(orgId, adminId, {
      provider: 'smtp_imap',
      account,
      imap: {
        host: testMail.host,
        port: testMail.imapPort,
        ssl: false,
        credential: 'imap-plain-secret',
      },
      smtp: {
        host: testMail.host,
        port: testMail.smtpPort,
        ssl: false,
        credential: 'smtp-plain-secret',
      },
      syncScope: { historyDays: 90, folders: ['INBOX', 'Sent'] },
    });
    mailboxId = view.mailboxId;
    // 响应剥除凭据
    expect(view.imap).toEqual({ host: testMail.host, port: testMail.imapPort, ssl: false });
    // 库内为密文且可解密回原文
    const [row] = await superDb
      .select()
      .from(schema.mailbox)
      .where(eq(schema.mailbox.id, mailboxId))
      .limit(1);
    expect(row?.imap?.credential_enc).toBeDefined();
    expect(row?.imap?.credential_enc).not.toContain('imap-plain-secret');
    expect(decryptSecret(row!.imap!.credential_enc!, process.env.ENCRYPTION_KEY!)).toBe(
      'imap-plain-secret',
    );
  });

  it('重复账号 → 40901（大小写不敏感唯一）', async () => {
    await expectBizError(
      mailboxService.create(orgId, adminId, {
        provider: 'smtp_imap',
        account: account.toUpperCase(),
        imap: { host: testMail.host, port: testMail.imapPort, ssl: false, credential: 'x' },
        smtp: { host: testMail.host, port: testMail.smtpPort, ssl: false, credential: 'x' },
        syncScope: { historyDays: 30, folders: ['INBOX'] },
      }),
      40901,
    );
  });

  it('连接测试：协议级可达 → connected；不可达 → error + lastError（M4 #4）', async () => {
    // 可达路径：真实驱动连本地 GreenMail（任意凭据可登录）→ 协议级 IMAP/SMTP 双通
    await mailboxService.update(orgId, mailboxId, {
      imap: {
        host: testMail.host,
        port: testMail.imapPort,
        ssl: false,
        credential: testMail.password,
      },
      smtp: {
        host: testMail.host,
        port: testMail.smtpPort,
        ssl: false,
        credential: testMail.password,
      },
    });
    const okResult = await mailboxService.test(orgId, mailboxId);
    expect(okResult).toMatchObject({ ok: true, imap: 'ok', smtp: 'ok' });

    // 更新为不可达端口（真实连接拒绝）→ 驱动连接失败 → error + lastError
    await mailboxService.update(orgId, mailboxId, {
      imap: { host: '127.0.0.1', port: 1, ssl: false, credential: 'imap-plain-secret' },
      smtp: { host: '127.0.0.1', port: 1, ssl: false, credential: 'smtp-plain-secret' },
    });
    const failResult = await mailboxService.test(orgId, mailboxId);
    expect(failResult.ok).toBe(false);
    expect(failResult.imap).toBe('fail');
    const [row] = await superDb
      .select()
      .from(schema.mailbox)
      .where(eq(schema.mailbox.id, mailboxId))
      .limit(1);
    expect(row?.status).toBe('error');
    expect(row?.lastError).not.toBeNull();
  }, 30_000);

  it('凭据与配置可分开更新（不传 credential 保留密文）', async () => {
    await mailboxService.update(orgId, mailboxId, {
      imap: {
        host: testMail.host,
        port: testMail.imapPort,
        ssl: true,
        credential: 'imap-plain-secret',
      },
    });
    const [row] = await superDb
      .select()
      .from(schema.mailbox)
      .where(eq(schema.mailbox.id, mailboxId))
      .limit(1);
    expect(decryptSecret(row!.imap!.credential_enc!, process.env.ENCRYPTION_KEY!)).toBe(
      'imap-plain-secret',
    );
    expect(row?.imap?.ssl).toBe(true);
  });

  it('创建成功 → onboarding mailbox 步骤置 done（16 §1.2 联动）', async () => {
    const status = await orgService.getOnboarding(orgId);
    expect(status.steps.find((s) => s.key === 'mailbox')?.done).toBe(true);
  });

  it('删除邮箱连接', async () => {
    await mailboxService.remove(orgId, mailboxId);
    await expectBizError(mailboxService.test(orgId, mailboxId), 40401);
  });
});

describe('权限管理（16 §1.7/§3.6）', () => {
  it('GET 返回注册种子矩阵', async () => {
    const sales = await settings.getRolePermissions(orgId, 'sales');
    expect(sales.permissions.customers).toBe('self');
    expect(sales.permissions.settings).toBe('none');
  });

  it('mandatory 审批类型 approverRoles 置空 → 42201', async () => {
    await expectBizError(
      settings.updateRolePermissions(orgId, adminId, 'sales', {
        approvalRules: [{ approvalType: 'email_send', approverRoles: [] }],
      }),
      42201,
    );
  });

  it('high 风险类型（quote）禁 autoApprove → 42201', async () => {
    await expectBizError(
      settings.updateRolePermissions(orgId, adminId, 'sales', {
        approvalRules: [{ approvalType: 'quote', approverRoles: ['admin'], autoApprove: true }],
      }),
      42201,
    );
  });

  it('合法更新持久化；DTO 校验非法角色权限枚举', async () => {
    await settings.updateRolePermissions(orgId, adminId, 'sales', {
      permissions: {
        customers: 'self',
        quotes: 'view',
        approvals: ['email_send'],
        settings: 'view',
      },
      approvalRules: [
        {
          approvalType: 'email_send',
          approverRoles: ['admin', 'manager'],
          autoApprove: true,
          expireHours: 6,
        },
      ],
    });
    const sales = await settings.getRolePermissions(orgId, 'sales');
    expect(sales.permissions.settings).toBe('view');
    expect(sales.approvalRules[0]?.approverRoles).toEqual(['admin', 'manager']);
    // M3-14：按类型审批超时随 approvalRules 持久化（12 §7.2）
    expect(sales.approvalRules[0]?.expireHours).toBe(6);

    const bad = rolePermissionsSchema.safeParse({
      permissions: { customers: 'everyone', quotes: 'view', approvals: [], settings: 'none' },
    });
    expect(bad.success).toBe(false);

    // M3-14：expireHours 越界（0 / 超 720）拒绝
    expect(
      rolePermissionsSchema.safeParse({
        approvalRules: [{ approvalType: 'email_send', approverRoles: ['admin'], expireHours: 0 }],
      }).success,
    ).toBe(false);
    expect(
      rolePermissionsSchema.safeParse({
        approvalRules: [{ approvalType: 'email_send', approverRoles: ['admin'], expireHours: 721 }],
      }).success,
    ).toBe(false);
  });
});

describe('通知设置（16 §1.8 FR-09）', () => {
  it('GET 缺行自动落默认（事件 × 渠道矩阵）', async () => {
    const view = await settings.getNotifications(orgId);
    expect(view.events.approval_pending).toEqual({ site: true, email: true });
    expect(view.events.task_failed).toEqual({ site: true, email: false });
  });

  it('PUT 局部合并；channels 列存聚合总开关', async () => {
    await settings.updateNotifications(orgId, {
      events: { task_failed: { site: false, email: false } },
    });
    let view = await settings.getNotifications(orgId);
    expect(view.events.task_failed).toEqual({ site: false, email: false });
    expect(view.events.approval_pending).toEqual({ site: true, email: true });

    const [row] = await superDb
      .select()
      .from(schema.notificationSetting)
      .where(eq(schema.notificationSetting.orgId, orgId))
      .limit(1);
    // email 渠道仍有事件启用（approval_pending.email=true）
    expect(row?.channels).toMatchObject({ site: true, email: true });

    // 全关 → 聚合开关落 false
    await settings.updateNotifications(orgId, {
      events: {
        approval_pending: { site: false, email: false },
        risk_alert: { site: false, email: false },
        task_failed: { site: false, email: false },
      },
    });
    view = await settings.getNotifications(orgId);
    const [row2] = await superDb
      .select()
      .from(schema.notificationSetting)
      .where(eq(schema.notificationSetting.orgId, orgId))
      .limit(1);
    expect(row2?.channels).toMatchObject({ site: false, email: false });
    expect(view.events.approval_pending).toEqual({ site: false, email: false });
  });
});

describe('AI 模型配置（16 §1.8 FR-10）', () => {
  it('GET 返回注册种子 4 场景', async () => {
    const { scenes } = await settings.getAiModels(orgId);
    expect(scenes.map((s) => s.scene).sort()).toEqual([
      'analysis',
      'email_reply',
      'follow_up',
      'lead_hunting',
    ]);
  });

  it('PUT 更新已有场景仅覆盖传入字段；金额/温度序列化往返', async () => {
    const { scenes } = await settings.updateAiModels(orgId, {
      scenes: [
        {
          scene: 'email_reply',
          model: 'gpt-4o-2024-11-20',
          temperature: 0.55,
          budgetLimit: 120.5,
        },
      ],
    });
    const reply = scenes.find((s) => s.scene === 'email_reply');
    expect(reply?.model).toBe('gpt-4o-2024-11-20');
    expect(reply?.temperature).toBe('0.55');
    expect(reply?.budgetLimit).toBe('120.50');
    // maxTokens 未传 → 保留种子值
    expect(reply?.maxTokens).toBe(2048);
    // 其他场景不受影响
    expect(scenes.find((s) => s.scene === 'analysis')?.model).toBe('gpt-4o');
  });
});
