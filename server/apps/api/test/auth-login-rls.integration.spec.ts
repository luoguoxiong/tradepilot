import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { BizException, createId, ErrorCode } from '@tradepilot/core';
import { closeDb, createDb, schema, withLoginContext, withOrg, type Db } from '@tradepilot/db';
import { EnvService } from '../src/config/env.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { TokenService } from '../src/auth/token.service.js';
import { OrgService } from '../src/org/org.service.js';

/**
 * login 路径 RLS 回归锚点（2026-09-09 线上拦截级缺陷复盘）：
 *
 * 旧实现把 user_account 与 org inner join 放进 withLoginContext 单查询——
 * org 表 RLS 一律按 app.org_id 过滤，而登录上下文未设置 org_id，
 * 导致 join 恒空、即使用户/密码正确也统一 40101（owner 建库角色绕过 RLS 掩盖问题）。
 *
 * 修复 = 两段式：先 login 上下文查 user（login_lookup 策略），再 org 上下文独立读 onboarding。
 * 本 spec 固话该约束，防止未来重构回退成单 join 查询：
 *  - 行为断言：有效账号登录成功且 onboarding 取回组织真实进度（回归若复现会直接失败）；
 *  - 语义锚点：login 上下文 innerJoin org 必须恒空（若有人放宽 RLS 需同步重新评估两段式）。
 *
 * 前置：docker compose up（PG 5432 + Redis）+ 迁移已执行 + tradepilot_app 角色存在（FORCE RLS）。
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

const runId = createId('org');
// register/login 落库前会 toLowerCase()，直接 SQL 断言也须用小写 email
const email = `it-rls-${runId.replace('org_', '').slice(0, 12)}@test.com`.toLowerCase();
const password = 'Passw0rd!';
/** 测试固定虚拟 IP（TEST-NET-1）；账号键按邮箱随机、IP 键 afterAll 清理，避免污染 15min 限流窗口 */
const clientIp = '198.51.100.77';

let orgId = '';
let adminId = '';

async function expectBizError(p: Promise<unknown>, code: number, message?: string): Promise<void> {
  try {
    await p;
    expect.fail(`应抛出错误码 ${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(BizException);
    expect((e as BizException).code).toBe(code);
    if (message !== undefined) {
      expect((e as BizException).message).toBe(message);
    }
  }
}

beforeAll(async () => {
  superDb = createDb(SUPER_URL, { max: 2 });
  appDb = createDb(APP_URL, { max: 5 });
  redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 2 });
  const env = new EnvService();
  const tokens = new TokenService(env, redis);
  auth = new AuthService(appDb, tokens, redis);
  orgService = new OrgService(appDb, redis);

  // 注册 = 单事务 org + admin + 种子，onboarding 默认 currentStep=1
  const session = await auth.register({
    companyName: 'IT 登录 RLS 测试租户',
    contactName: '测试管理员',
    email,
    password,
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
  const refreshKeys = await redis.keys(`refresh:${adminId}:*`);
  if (refreshKeys.length > 0) {
    await redis.del(...refreshKeys);
  }
  await redis.del(`rl:login:u:${email}`, `rl:login:ip:${clientIp}`);
  await redis.quit();
  await closeDb(appDb);
  await closeDb(superDb);
});

describe('login RLS 两段式回归（03 §1.1 / 08 §3）', () => {
  it('有效账号登录成功：签发 access/refresh，onboarding 取回组织真实进度', async () => {
    const r = await auth.login({ email, password }, clientIp);
    expect(r.token).toBeTruthy();
    expect(r.refreshToken).toBeTruthy();
    expect(r.expiresIn).toBeGreaterThan(0);
    // 新注册租户默认 currentStep=1（org.onboarding jsonb，须经 org 上下文读回）
    expect(r.onboarding).toEqual({ currentStep: 1 });
  });

  it('向导推进后再次登录返回推进后的 currentStep（org 读须与库内一致）', async () => {
    await orgService.updateOnboarding(orgId, 3);
    const r = await auth.login({ email, password }, clientIp);
    // 旧实现（login ctx 内 join 或读 org 失败被吞）会退化为 0/undefined
    expect(r.onboarding.currentStep).toBe(3);
  });

  it('防账号枚举：错误密码与不存在账号同为 40101 且文案一致', async () => {
    await expectBizError(
      auth.login({ email, password: 'wrong-pass' }, clientIp),
      ErrorCode.UNAUTHORIZED,
      '邮箱或密码错误',
    );
    await expectBizError(
      auth.login({ email: `nobody-${runId}@test.com`, password }, clientIp),
      ErrorCode.UNAUTHORIZED,
      '邮箱或密码错误',
    );
  });

  it('语义锚点：login 上下文可查 user 但 innerJoin org 恒空 → 登录必须两段式', async () => {
    // 两段式各自可达
    const userRows = await withLoginContext(appDb, (tx) =>
      tx
        .select({ id: schema.userAccount.id, orgId: schema.userAccount.orgId })
        .from(schema.userAccount)
        .where(eq(schema.userAccount.email, email))
        .limit(1),
    );
    expect(userRows).toHaveLength(1);

    const orgRows = await withOrg(appDb, orgId, (tx) =>
      tx
        .select({ id: schema.org.id, onboarding: schema.org.onboarding })
        .from(schema.org)
        .where(eq(schema.org.id, orgId))
        .limit(1),
    );
    expect(orgRows).toHaveLength(1);

    // 旧 bug 形态：单查询 innerJoin org（org RLS 按 app.org_id 过滤，登录上下文未设 org_id）→ 恒空
    const joined = await withLoginContext(appDb, (tx) =>
      tx
        .select({ id: schema.userAccount.id })
        .from(schema.userAccount)
        .innerJoin(schema.org, eq(schema.org.id, schema.userAccount.orgId))
        .where(eq(schema.userAccount.email, email))
        .limit(1),
    );
    expect(joined).toHaveLength(0);
  });
});
