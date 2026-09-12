import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { BizException, createId, ErrorCode } from '@tradepilot/core';
import { closeDb, createDb, schema, type Db, type OrgScopeContext } from '@tradepilot/db';
import { EnvService } from '../src/config/env.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { TokenService } from '../src/auth/token.service.js';
import { FollowUpsService } from '../src/follow-ups/follow-ups.service.js';
import { upsertStrategySchema, type UpsertStrategyDto } from '../src/follow-ups/follow-ups.dto.js';

/**
 * M5-D1 07-AI 自动跟进接口集成测试：
 * - summary 各 Tab 计数（today 按 org.timezone 当地日历日）；
 * - 策略列表含默认策略（isDefault）、创建/编辑/删除（业务校验 42201、默认策略与引用约束 40901）；
 * - apply 创建 followUpTask、重复 apply 返回 skipped task_exists；
 * - 任务列表（tab/keyword）、pause/skip、executions；
 * - 越权：sales 访问 strategy 写操作 → 40301。
 * 前置：docker compose up（PG 5432 / Redis 6380）+ 迁移已执行。
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

let orgId = '';
let adminId = '';
let salesId = '';
let adminCtx: OrgScopeContext;
let salesCtx: OrgScopeContext;
let followUps: FollowUpsService;

/** 策略 S2：apply/删除引用/skip 场景使用（首步 dayOffset=3，steps [3,6] → 编辑后 [3,6,9]） */
let stratId = '';
/** 客户 C1：apply 创建的进行中任务 */
let customerA = '';
/** apply 创建的 followUpTask id */
let taskA = '';

const adminEmail = `it-m5d1-${createId('org')}@test.com`;
const salesEmail = `it-m5d1-sales-${createId('org')}@test.com`;

/** org 时区（Asia/Shanghai）当地日历日 key（对齐 mock localDateKey） */
function localDateKey(iso: string | Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(iso));
}

async function expectBiz(promise: Promise<unknown>, code: number): Promise<BizException> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(BizException);
    expect((err as BizException).code).toBe(code);
    return err as BizException;
  }
  throw new Error(`期望抛出 BizException(${code}) 但未抛出`);
}

/** 构造合法策略 DTO（走 zod 管道同一入口，等价 controller 行为） */
function strategyDto(overrides: Partial<UpsertStrategyDto> = {}): UpsertStrategyDto {
  return upsertStrategySchema.parse({
    name: `策略-${createId('org')}`,
    targetScope: { customerValue: ['high'] },
    steps: [
      { seq: 1, dayOffset: 0, title: '首次触达', content: '价值主张开发信' },
      { seq: 2, dayOffset: 3, title: '二次跟进', content: '附加产品资料' },
    ],
    autoSendPolicy: 'manual_review',
    enabled: true,
    ...overrides,
  });
}

beforeAll(async () => {
  superDb = createDb(SUPER_URL, { max: 2 });
  appDb = createDb(APP_URL, { max: 5 });
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
  const env = new EnvService();
  const tokens = new TokenService(env, redis);
  const auth = new AuthService(appDb, tokens, redis);

  const session = await auth.register({
    companyName: 'IT M5 D1 跟进租户',
    contactName: '管理员',
    email: adminEmail,
    password: 'password123',
  });
  orgId = session.user.orgId;
  adminId = session.user.userId;

  // sales 成员 fixture（不经邀请链路；仅做角色越权断言）
  salesId = createId('usr');
  await superDb.insert(schema.userAccount).values({
    id: salesId,
    orgId,
    email: salesEmail,
    passwordHash: 'fixture_no_login',
    name: '销售乙',
    role: 'sales',
    status: 'active',
  });

  adminCtx = { orgId, userId: adminId, role: 'admin', scope: 'all' };
  salesCtx = { orgId, userId: salesId, role: 'sales', scope: 'self' };

  followUps = new FollowUpsService(appDb);

  // 客户 fixture
  customerA = createId('cus');
  await superDb.insert(schema.customer).values({
    id: customerA,
    orgId,
    companyName: 'M5D1 汉堡运动器材 GmbH',
    country: 'Germany',
    stage: 'new_lead',
    ownerId: adminId,
    createdBy: adminId,
  });
}, 30_000);

afterAll(async () => {
  if (orgId) {
    await superDb.transaction(async (tx) => {
      await tx.delete(schema.followUpExecution).where(eq(schema.followUpExecution.orgId, orgId));
      await tx.delete(schema.followUpTask).where(eq(schema.followUpTask.orgId, orgId));
      await tx
        .delete(schema.followUpStrategyStep)
        .where(eq(schema.followUpStrategyStep.orgId, orgId));
      await tx.delete(schema.followUpStrategy).where(eq(schema.followUpStrategy.orgId, orgId));
      await tx.delete(schema.customerInsight).where(eq(schema.customerInsight.orgId, orgId));
      await tx.delete(schema.customerActivity).where(eq(schema.customerActivity.orgId, orgId));
      await tx.delete(schema.contact).where(eq(schema.contact.orgId, orgId));
      await tx
        .delete(schema.conversationInsight)
        .where(eq(schema.conversationInsight.orgId, orgId));
      await tx.delete(schema.message).where(eq(schema.message.orgId, orgId));
      await tx.delete(schema.conversation).where(eq(schema.conversation.orgId, orgId));
      await tx.delete(schema.customer).where(eq(schema.customer.orgId, orgId));
      await tx.delete(schema.aiLeadContact).where(eq(schema.aiLeadContact.orgId, orgId));
      await tx.delete(schema.aiLead).where(eq(schema.aiLead.orgId, orgId));
      await tx.delete(schema.aiEmployee).where(eq(schema.aiEmployee.orgId, orgId));
      await tx.delete(schema.sopTemplate).where(eq(schema.sopTemplate.orgId, orgId));
      await tx.delete(schema.aiModelSetting).where(eq(schema.aiModelSetting.orgId, orgId));
      await tx.delete(schema.rolePermission).where(eq(schema.rolePermission.orgId, orgId));
      await tx.delete(schema.userAccount).where(eq(schema.userAccount.orgId, orgId));
      await tx.delete(schema.org).where(eq(schema.org.id, orgId));
    });
  }
  await redis.quit();
  await closeDb(appDb);
  await closeDb(superDb);
});

// ============================== 3.1 总览统计（空 org） ==============================

describe('M5-D1 · 总览统计（GET /follow-ups/summary）', () => {
  it('空 org：executingCount 与四 Tab 均为 0', async () => {
    const s = await followUps.summary(adminCtx);
    expect(s).toEqual({
      executingCount: 0,
      tabs: { all: 0, today: 0, waitingApproval: 0, completed: 0 },
    });
  });
});

// ============================== 3.3 策略列表 ==============================

describe('M5-D1 · 策略列表（GET /follow-up-strategies）', () => {
  it('默认策略在列且 isDefault=true（seedOrg 生成，五步含 Break-up）', async () => {
    const resp = await followUps.listStrategies(adminCtx, { page: 1, pageSize: 50 });
    const def = resp.items.find((s) => s.isDefault);
    expect(def).toBeDefined();
    expect(def!.name).toBe('默认跟进策略');
    // 契约：默认策略 targetScope.customerValue 必须为完整数组（前端 scopeSummary/copy 直取，缺失会抛错）
    expect(Array.isArray(def!.targetScope.customerValue)).toBe(true);
    expect(def!.targetScope.customerValue).toEqual(['high', 'medium', 'low']);
    expect(def!.steps.length).toBe(5);
    expect(def!.steps[0]!.dayOffset).toBe(0);
    expect(def!.steps[4]!.isBreakup).toBe(true);
    expect(def!.steps[4]!.channel).toBe('email');
  });
});

// ============================== 3.3 新建策略 ==============================

describe('M5-D1 · 新建策略（POST /follow-up-strategies）', () => {
  it('创建成功：seq 归一 + isBreakup 系统置位 + channel 固定 email', async () => {
    const resp = await followUps.createStrategy(
      adminCtx,
      strategyDto({
        name: 'D1 测试策略 A',
        steps: [
          { seq: 9, dayOffset: 3, title: '首触', content: 'hi' },
          { seq: 9, dayOffset: 6, title: '二触', content: 'hello', isBreakup: true },
        ],
      }),
    );
    stratId = resp.strategyId;
    expect(stratId.startsWith('strat_')).toBe(true);

    const rows = await superDb
      .select()
      .from(schema.followUpStrategyStep)
      .where(eq(schema.followUpStrategyStep.strategyId, stratId))
      .orderBy(schema.followUpStrategyStep.seq);
    expect(
      rows.map((r) => ({
        seq: r.seq,
        dayOffset: r.dayOffset,
        isBreakup: r.isBreakup,
        channel: r.channel,
      })),
    ).toEqual([
      { seq: 1, dayOffset: 3, isBreakup: false, channel: 'email' },
      { seq: 2, dayOffset: 6, isBreakup: true, channel: 'email' },
    ]);
  });

  it('dayOffset 重复 → 42201', async () => {
    await expectBiz(
      followUps.createStrategy(
        adminCtx,
        strategyDto({
          steps: [
            { seq: 1, dayOffset: 0, title: 'a' },
            { seq: 2, dayOffset: 0, title: 'b' },
          ],
        }),
      ),
      ErrorCode.BIZ_VALIDATION,
    );
  });

  it('dayOffset 不递增 → 42201', async () => {
    await expectBiz(
      followUps.createStrategy(
        adminCtx,
        strategyDto({
          steps: [
            { seq: 1, dayOffset: 3, title: 'a' },
            { seq: 2, dayOffset: 1, title: 'b' },
          ],
        }),
      ),
      ErrorCode.BIZ_VALIDATION,
    );
  });

  it('含 Break-up 且 autoSendPolicy=auto_send → 42201（Break-up 强制 manual_review）', async () => {
    await expectBiz(
      followUps.createStrategy(
        adminCtx,
        strategyDto({
          autoSendPolicy: 'auto_send',
          steps: [
            { seq: 1, dayOffset: 0, title: 'a' },
            { seq: 2, dayOffset: 5, title: 'breakup', isBreakup: true },
          ],
        }),
      ),
      ErrorCode.BIZ_VALIDATION,
    );
  });

  it('名称为空 → 42201', async () => {
    await expectBiz(
      followUps.createStrategy(adminCtx, strategyDto({ name: '   ' })),
      ErrorCode.BIZ_VALIDATION,
    );
  });

  it('至少 1 步 → 42201（steps 空数组）', async () => {
    await expectBiz(
      followUps.createStrategy(adminCtx, strategyDto({ steps: [] })),
      ErrorCode.BIZ_VALIDATION,
    );
  });
});

// ============================== 3.3 编辑策略 ==============================

describe('M5-D1 · 编辑策略（PUT /follow-up-strategies/{id}）', () => {
  it('编辑非默认策略成功：策略头更新 + steps 重建（删旧插新，dayOffset 首步保持 3）', async () => {
    const resp = await followUps.updateStrategy(
      adminCtx,
      stratId,
      strategyDto({
        name: 'D1 测试策略 A-v2',
        steps: [
          { seq: 1, dayOffset: 3, title: '首触', content: 'hi' },
          { seq: 2, dayOffset: 6, title: '二次跟进', content: '附加产品资料' },
          { seq: 3, dayOffset: 9, title: 'breakup', content: 'y', isBreakup: true },
        ],
      }),
    );
    expect(resp.strategyId).toBe(stratId);

    const [header] = await superDb
      .select()
      .from(schema.followUpStrategy)
      .where(eq(schema.followUpStrategy.id, stratId));
    expect(header!.name).toBe('D1 测试策略 A-v2');

    const steps = await superDb
      .select()
      .from(schema.followUpStrategyStep)
      .where(eq(schema.followUpStrategyStep.strategyId, stratId))
      .orderBy(schema.followUpStrategyStep.seq);
    expect(steps.map((s) => s.dayOffset)).toEqual([3, 6, 9]);
  });

  it('编辑默认策略 → 40901', async () => {
    const resp = await followUps.listStrategies(adminCtx, { page: 1, pageSize: 50 });
    const def = resp.items.find((s) => s.isDefault)!;
    await expectBiz(
      followUps.updateStrategy(adminCtx, def.strategyId, strategyDto()),
      ErrorCode.CONFLICT,
    );
  });
});

// ============================== 3.3 删除策略 ==============================

describe('M5-D1 · 删除策略（DELETE /follow-up-strategies/{id}）', () => {
  it('删除默认策略 → 40901', async () => {
    const resp = await followUps.listStrategies(adminCtx, { page: 1, pageSize: 50 });
    const def = resp.items.find((s) => s.isDefault)!;
    await expectBiz(followUps.deleteStrategy(adminCtx, def.strategyId), ErrorCode.CONFLICT);
  });

  it('apply 后删除被引用策略 → 40901（进行中任务引用）', async () => {
    // C1 尚无进行中任务 → apply 创建
    const applyResp = await followUps.apply(adminCtx, stratId, { customerIds: [customerA] });
    expect(applyResp.created).toHaveLength(1);
    expect(applyResp.skipped).toHaveLength(0);
    taskA = applyResp.created[0]!.followUpTaskId;

    const [taskRow] = await superDb
      .select()
      .from(schema.followUpTask)
      .where(eq(schema.followUpTask.id, taskA));
    expect(taskRow!.currentStage).toBe('follow_up_1');
    expect(taskRow!.status).toBe('scheduled'); // 首步 dayOffset=3 > 0
    expect(taskRow!.nextRunAt).not.toBeNull();

    await expectBiz(followUps.deleteStrategy(adminCtx, stratId), ErrorCode.CONFLICT);
  });

  it('删除未引用非默认策略成功', async () => {
    const resp = await followUps.createStrategy(adminCtx, strategyDto({ name: 'D1 临时策略 S3' }));
    const del = await followUps.deleteStrategy(adminCtx, resp.strategyId);
    expect(del).toEqual({ deleted: true });
    const [gone] = await superDb
      .select()
      .from(schema.followUpStrategy)
      .where(eq(schema.followUpStrategy.id, resp.strategyId));
    expect(gone).toBeUndefined();
  });
});

// ============================== 3.5 apply 应用策略 ==============================

describe('M5-D1 · apply 应用策略到客户（POST /follow-up-strategies/{id}/apply）', () => {
  it('重复 apply（已有进行中任务）→ skipped task_exists', async () => {
    const resp = await followUps.apply(adminCtx, stratId, { customerIds: [customerA] });
    expect(resp.created).toHaveLength(0);
    expect(resp.skipped).toEqual([{ customerId: customerA, reason: 'task_exists' }]);
  });

  it('customerIds 为空 → 40001', async () => {
    await expectBiz(followUps.apply(adminCtx, stratId, { customerIds: [] }), ErrorCode.BAD_REQUEST);
  });

  it('客户不存在 → 40001', async () => {
    await expectBiz(
      followUps.apply(adminCtx, stratId, { customerIds: ['cus_not_exist'] }),
      ErrorCode.BAD_REQUEST,
    );
  });

  it('策略不存在 → 40401', async () => {
    await expectBiz(
      followUps.apply(adminCtx, 'strat_not_exist', { customerIds: [customerA] }),
      ErrorCode.NOT_FOUND,
    );
  });
});

// ============================== 3.1 总览统计（fixture 计数）+ 3.2 任务列表 ==============================

describe('M5-D1 · summary 计数与任务列表（today 口径 = org 当地日历日）', () => {
  beforeAll(async () => {
    // fixture：跨状态任务（C2~C5 独立客户满足 uq_ftask_org_customer_strategy）
    const statuses = ['waiting_approval', 'completed', 'paused', 'scheduled'] as const;
    for (let i = 0; i < statuses.length; i += 1) {
      const cusId = createId('cus');
      await superDb.insert(schema.customer).values({
        id: cusId,
        orgId,
        companyName: `M5D1 状态客户 ${i} GmbH`,
        country: 'Germany',
        stage: 'new_lead',
        ownerId: adminId,
      });
      const nextRunAt = statuses[i] === 'scheduled' ? new Date() : null; // scheduled → now → 今天
      await superDb.insert(schema.followUpTask).values({
        id: createId('ftask'),
        orgId,
        customerId: cusId,
        strategyId: stratId,
        currentStage: 'follow_up_1',
        nextRunAt,
        status: statuses[i],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  });

  it('summary：today=1 / waitingApproval=1 / completed=1 / all=5 / executingCount=3', async () => {
    // C1（apply 任务，firstDay=3 → nextRunAt≈now+3d）不计入 today
    const s = await followUps.summary(adminCtx);
    expect(s.tabs.waitingApproval).toBe(1);
    expect(s.tabs.completed).toBe(1);
    expect(s.tabs.today).toBe(1);
    expect(s.tabs.all).toBe(5); // 4 fixture + 1 apply（C1）
    expect(s.executingCount).toBe(3); // 5 - completed(1) - paused(1)
  });

  it('任务列表字段聚合：companyName/strategyName + keyword 命中', async () => {
    const all = await followUps.listTasks(adminCtx, { page: 1, pageSize: 50 });
    const target = all.items.find((i) => i.followUpTaskId === taskA);
    expect(target).toBeDefined();
    expect(target!.companyName).toBe('M5D1 汉堡运动器材 GmbH');
    expect(target!.strategyId).toBe(stratId);
    expect(target!.strategyName).toBe('D1 测试策略 A-v2');
    expect(target!.currentStage).toBe('follow_up_1');
    expect(target!.nextRunAt).not.toBeNull();

    const kw = await followUps.listTasks(adminCtx, { page: 1, pageSize: 50, keyword: '汉堡' });
    expect(kw.items.map((i) => i.followUpTaskId)).toContain(taskA);
  });

  it('tab=waiting_approval / completed 筛选', async () => {
    const wait = await followUps.listTasks(adminCtx, {
      page: 1,
      pageSize: 50,
      tab: 'waiting_approval',
    });
    expect(wait.items.every((i) => i.status === 'waiting_approval')).toBe(true);
    expect(wait.total).toBe(1);

    const comp = await followUps.listTasks(adminCtx, { page: 1, pageSize: 50, tab: 'completed' });
    expect(comp.items.every((i) => i.status === 'completed')).toBe(true);
    expect(comp.total).toBe(1);
  });

  it('tab=today：仅当地日历日 == 今天的任务（apply 任务 now+3d 不命中）', async () => {
    const today = await followUps.listTasks(adminCtx, { page: 1, pageSize: 50, tab: 'today' });
    expect(today.items.length).toBe(1);
    const todayKey = localDateKey(new Date());
    for (const i of today.items) {
      expect(localDateKey(i.nextRunAt!)).toBe(todayKey);
    }
    expect(today.items.some((i) => i.followUpTaskId === taskA)).toBe(false);
  });
});

// ============================== 2.5 暂停 / 跳过 ==============================

describe('M5-D1 · 暂停 / 跳过（POST /follow-up-tasks/{id}/pause|skip）', () => {
  let waitTaskId = '';
  let compTaskId = '';
  let todayTaskId = '';

  beforeAll(async () => {
    const all = await followUps.listTasks(adminCtx, { page: 1, pageSize: 50 });
    waitTaskId = all.items.find((i) => i.status === 'waiting_approval')!.followUpTaskId;
    compTaskId = all.items.find((i) => i.status === 'completed')!.followUpTaskId;
    todayTaskId = all.items.find(
      (i) => i.status === 'scheduled' && i.followUpTaskId !== taskA,
    )!.followUpTaskId;
  });

  it('pause：waiting_approval → paused，重复 pause 幂等', async () => {
    const resp = await followUps.pause(adminCtx, waitTaskId);
    expect(resp).toEqual({ followUpTaskId: waitTaskId, status: 'paused' });
    const again = await followUps.pause(adminCtx, waitTaskId);
    expect(again.status).toBe('paused');
    const [row] = await superDb
      .select({ status: schema.followUpTask.status })
      .from(schema.followUpTask)
      .where(eq(schema.followUpTask.id, waitTaskId));
    expect(row!.status).toBe('paused');
  });

  it('pause completed → 40901；任务不存在 → 40401', async () => {
    await expectBiz(followUps.pause(adminCtx, compTaskId), ErrorCode.CONFLICT);
    await expectBiz(followUps.pause(adminCtx, 'ftask_not_exist'), ErrorCode.NOT_FOUND);
  });

  it('skip：nextRunAt 顺延到下一步（S2 dayOffset 3→6，gap 3 天）且状态不变', async () => {
    const [before] = await superDb
      .select({ nextRunAt: schema.followUpTask.nextRunAt })
      .from(schema.followUpTask)
      .where(eq(schema.followUpTask.id, todayTaskId));
    const old = before!.nextRunAt!;
    const t0 = Date.now();

    const resp = await followUps.skip(adminCtx, todayTaskId);
    expect(resp.followUpTaskId).toBe(todayTaskId);
    const after = new Date(resp.nextRunAt);
    // 下一步相对当前 stage 的 dayOffset gap=3 → 至少 +3 天（窗口对齐只推后不提前）
    expect(after.getTime()).toBeGreaterThanOrEqual(old.getTime() + 3 * 86_400_000 - 1_000);
    expect(after.getTime()).toBeGreaterThanOrEqual(t0 + 3 * 86_400_000 - 1_000);

    const [row] = await superDb
      .select({ nextRunAt: schema.followUpTask.nextRunAt, status: schema.followUpTask.status })
      .from(schema.followUpTask)
      .where(eq(schema.followUpTask.id, todayTaskId));
    expect(row!.nextRunAt!.getTime()).toBe(after.getTime());
    expect(row!.status).toBe('scheduled');
  });

  it('skip completed → 40901；任务不存在 → 40401', async () => {
    await expectBiz(followUps.skip(adminCtx, compTaskId), ErrorCode.CONFLICT);
    await expectBiz(followUps.skip(adminCtx, 'ftask_not_exist'), ErrorCode.NOT_FOUND);
  });
});

// ============================== 3.4 执行记录 ==============================

describe('M5-D1 · 执行记录（GET /follow-up-strategies/{id}/executions）', () => {
  it('按策略聚合任务执行记录，sentAt desc 排序（null 置尾）', async () => {
    // 手动插三行（taskA：sent / approved / skipped）
    await superDb.insert(schema.followUpExecution).values([
      {
        id: createId('fexc'),
        orgId,
        followUpTaskId: taskA,
        stepTitle: '首次触达',
        status: 'sent',
        content: '价值主张开发信',
        sentAt: new Date(Date.now() - 2 * 86_400_000),
      },
      {
        id: createId('fexc'),
        orgId,
        followUpTaskId: taskA,
        stepTitle: '二次跟进',
        status: 'approved',
        approvedBy: adminId,
        sentAt: new Date(Date.now() - 86_400_000),
      },
      {
        id: createId('fexc'),
        orgId,
        followUpTaskId: taskA,
        stepTitle: '频控顺延',
        status: 'skipped',
        skipReason: 'frequency_capped',
        sentAt: null,
      },
    ]);

    const resp = await followUps.executions(adminCtx, stratId, 1, 50);
    expect(resp.total).toBe(3);
    expect(resp.items.map((i) => i.status)).toEqual(['approved', 'sent', 'skipped']);
    expect(resp.items[0]!.stepTitle).toBe('二次跟进');
    expect(resp.items[0]!.approvedBy).toBe(adminId);
    expect(resp.items[2]!.skipReason).toBe('frequency_capped');
    expect(resp.items[2]!.sentAt).toBeNull();
  });

  it('策略不存在 → 40401；默认策略无执行记录 → 空页', async () => {
    await expectBiz(followUps.executions(adminCtx, 'strat_not_exist', 1, 20), ErrorCode.NOT_FOUND);
    const resp = await followUps.listStrategies(adminCtx, { page: 1, pageSize: 50 });
    const def = resp.items.find((s) => s.isDefault)!;
    const empty = await followUps.executions(adminCtx, def.strategyId, 1, 20);
    expect(empty.total).toBe(0);
    expect(empty.items).toEqual([]);
  });
});

// ============================== 越权（sales） ==============================

describe('M5-D1 · 越权：sales 访问 strategy 写操作', () => {
  it('sales 创建策略 → 40301', async () => {
    await expectBiz(followUps.createStrategy(salesCtx, strategyDto()), ErrorCode.FORBIDDEN);
  });

  it('sales 编辑策略 → 40301', async () => {
    await expectBiz(
      followUps.updateStrategy(salesCtx, stratId, strategyDto()),
      ErrorCode.FORBIDDEN,
    );
  });

  it('sales 删除策略 → 40301', async () => {
    await expectBiz(followUps.deleteStrategy(salesCtx, stratId), ErrorCode.FORBIDDEN);
  });

  it('sales 仍可读：策略列表 / 任务列表可见', async () => {
    const strategies = await followUps.listStrategies(salesCtx, { page: 1, pageSize: 50 });
    expect(strategies.total).toBeGreaterThanOrEqual(1);
    const tasks = await followUps.listTasks(salesCtx, { page: 1, pageSize: 50 });
    expect(tasks.total).toBeGreaterThanOrEqual(1);
  });
});
