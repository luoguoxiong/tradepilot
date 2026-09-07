import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { createId } from '@tradepilot/core';
import { closeDb, createDb, schema, type Db } from '@tradepilot/db';
import { TaskEnqueuer } from '@tradepilot/runtime';
import type { TaskType } from '@tradepilot/shared';
import { EnvService } from '../src/config/env.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { TokenService } from '../src/auth/token.service.js';
import { TasksService } from '../src/tasks/tasks.service.js';

/**
 * M3-01 回归集成测试（POST /tasks 直投路径）：
 * - 根因：API 直投把任务直接落 `status='running'` 且 `started_at=null`，Runner claim 只认
 *   scheduled→running → 永久卡死并累积冻结 org 并发；入队在事务内还可能先于提交被消费。
 * - 修复后语义（M3 代码评审缺陷清单 P0）：
 *   ① 恒落 scheduled（running 由 Runner.claim 独占置位并补 started_at）；
 *   ② 入队移到事务提交之后；
 *   ③ 未来 scheduled_at 不直投（本应 delayed，交由 Dispatcher 到点投递）。
 * 断言以「毒态不变式」为核心：任何时刻 org 内不允许存在 running + started_at 为 null 的任务行。
 * 前置：docker compose up（PG 5432 / Redis 6380）+ 迁移已执行 + tradepilot_app 角色存在。
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
let tasksService: TasksService;
let probeEnqueuer: TaskEnqueuer;

let orgId = '';
let adminId = '';
const adminEmail = `it-tasks-${createId('org')}@test.com`;

/** 本次用例入队的任务（afterAll 尽力清掉 BullMQ job，防止无主 job 落库噪音） */
const enqueued: { taskId: string; type: string }[] = [];

/** 毒态不变式：org 内 running 且 started_at 为 null 的行（旧实现直投即产生、永久卡死冻结并发） */
async function countPoison(): Promise<number> {
  const rows = await superDb
    .select({ id: schema.aiTask.id })
    .from(schema.aiTask)
    .where(
      and(
        eq(schema.aiTask.orgId, orgId),
        eq(schema.aiTask.status, 'running'),
        sql`${schema.aiTask.startedAt} is null`,
      ),
    );
  return rows.length;
}

async function readTask(taskId: string): Promise<{
  status: string;
  startedAt: Date | null;
  scheduledAt: Date | null;
}> {
  const [row] = await superDb
    .select({
      status: schema.aiTask.status,
      startedAt: schema.aiTask.startedAt,
      scheduledAt: schema.aiTask.scheduledAt,
    })
    .from(schema.aiTask)
    .where(eq(schema.aiTask.id, taskId))
    .limit(1);
  if (!row) {
    throw new Error(`任务不存在: ${taskId}`);
  }
  return { status: row.status, startedAt: row.startedAt, scheduledAt: row.scheduledAt };
}

beforeAll(async () => {
  superDb = createDb(SUPER_URL, { max: 2 });
  appDb = createDb(APP_URL, { max: 5 });
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
  const env = new EnvService();
  const tokens = new TokenService(env, redis);
  const auth = new AuthService(appDb, tokens, redis);
  tasksService = new TasksService(appDb, redis, env);
  probeEnqueuer = new TaskEnqueuer(process.env.REDIS_URL!);

  // 注册企业（register 全链路：org + admin + 六预置 AI 员工种子，03 §1.1）
  const session = await auth.register({
    companyName: 'IT 任务直投回归租户',
    contactName: '管理员',
    email: adminEmail,
    password: 'password123',
  });
  orgId = session.user.orgId;
  adminId = session.user.userId;
}, 30_000);

afterAll(async () => {
  if (orgId) {
    // 清理 BullMQ job（best-effort）
    for (const { taskId, type } of enqueued) {
      await probeEnqueuer.removeTask(taskId, type as TaskType).catch(() => undefined);
    }
    // 清理业务数据（含 dev worker 偶发执行产生的子表）
    await superDb.transaction(async (tx) => {
      await tx.delete(schema.llmCall).where(eq(schema.llmCall.orgId, orgId));
      await tx.delete(schema.aiTaskLog).where(eq(schema.aiTaskLog.orgId, orgId));
      await tx.delete(schema.aiTaskStep).where(eq(schema.aiTaskStep.orgId, orgId));
      await tx.delete(schema.aiTask).where(eq(schema.aiTask.orgId, orgId));
      await tx.delete(schema.approvalLog).where(eq(schema.approvalLog.orgId, orgId));
      await tx.delete(schema.approvalRequest).where(eq(schema.approvalRequest.orgId, orgId));
      await tx.delete(schema.followUpExecution).where(eq(schema.followUpExecution.orgId, orgId));
      await tx.delete(schema.followUpTask).where(eq(schema.followUpTask.orgId, orgId));
      await tx
        .delete(schema.followUpStrategyStep)
        .where(eq(schema.followUpStrategyStep.orgId, orgId));
      await tx.delete(schema.followUpStrategy).where(eq(schema.followUpStrategy.orgId, orgId));
      await tx.delete(schema.message).where(eq(schema.message.orgId, orgId));
      await tx.delete(schema.conversation).where(eq(schema.conversation.orgId, orgId));
      await tx.delete(schema.customerActivity).where(eq(schema.customerActivity.orgId, orgId));
      await tx.delete(schema.aiLeadContact).where(eq(schema.aiLeadContact.orgId, orgId));
      await tx.delete(schema.aiLead).where(eq(schema.aiLead.orgId, orgId));
      await tx.delete(schema.customer).where(eq(schema.customer.orgId, orgId));
      await tx.delete(schema.aiEmployee).where(eq(schema.aiEmployee.orgId, orgId));
      await tx.delete(schema.sopTemplate).where(eq(schema.sopTemplate.orgId, orgId));
      await tx.delete(schema.aiModelSetting).where(eq(schema.aiModelSetting.orgId, orgId));
      await tx.delete(schema.rolePermission).where(eq(schema.rolePermission.orgId, orgId));
      await tx.delete(schema.userAccount).where(eq(schema.userAccount.orgId, orgId));
      await tx.delete(schema.org).where(eq(schema.org.id, orgId));
    });
  }
  await probeEnqueuer.close();
  await redis.quit();
  await tasksService.onModuleDestroy();
  await closeDb(appDb);
  await closeDb(superDb);
});

describe('POST /tasks 直投路径（M3-01）', () => {
  // 预置员工角色固定：lead_hunter / follow_up / customer_researcher
  const employeeIdOf = async (
    role: 'lead_hunter' | 'follow_up' | 'customer_researcher',
  ): Promise<string> => {
    const [emp] = await superDb
      .select({ id: schema.aiEmployee.id })
      .from(schema.aiEmployee)
      .where(and(eq(schema.aiEmployee.orgId, orgId), eq(schema.aiEmployee.role, role)))
      .limit(1);
    if (!emp) {
      throw new Error(`种子员工缺失: ${role}`);
    }
    return emp.id;
  };

  it('员工空闲直投：恒落 scheduled，不产生 running+started_at 空行，可被 Runner claim 接管', async () => {
    const empLead = await employeeIdOf('lead_hunter');
    const resp = await tasksService.create(orgId, adminId, {
      employeeId: empLead,
      type: 'lead_hunting',
      title: 'M3-01 直投回归·空闲直投',
      input: { goal: 'M3-01 回归目标' },
    });
    // 合同口径（14 §3.2）：并发空闲 → 立即投递（响应 running）
    expect(resp.status).toBe('running');
    expect(await countPoison()).toBe(0);
    enqueued.push({ taskId: resp.taskId, type: 'lead_hunting' });

    // 入队（提交后）生效：BullMQ 活跃 job 存在，或任务已被 worker 消费推进
    const jobActive = await probeEnqueuer.hasActiveJob(resp.taskId, 'lead_hunting');
    let row = await readTask(resp.taskId);
    expect(jobActive || row.status !== 'scheduled').toBe(true);

    // 语义统一：未消费前恒 scheduled（started_at 空），绝不 running+空（毒态根因）
    row = await readTask(resp.taskId);
    if (row.status === 'scheduled') {
      expect(row.startedAt).toBeNull();
      expect(row.scheduledAt).toBeNull();
      // 复刻 Runner.claim 乐观锁：scheduled → running 并补 started_at（0 行命中即无法接管 = 卡死）
      const claimed = await superDb
        .update(schema.aiTask)
        .set({ status: 'running', startedAt: new Date() })
        .where(and(eq(schema.aiTask.id, resp.taskId), eq(schema.aiTask.status, 'scheduled')))
        .returning({ id: schema.aiTask.id });
      expect(claimed.length).toBe(1);
      row = await readTask(resp.taskId);
      expect(row.status).toBe('running');
    }
    expect(row.startedAt).not.toBeNull();
    expect(await countPoison()).toBe(0);
  });

  it('员工已有 running 任务 → 排队（scheduled），不直投', async () => {
    const empFollow = await employeeIdOf('follow_up');
    // 造一条合法 running（started_at 已补）占用员工并发=1
    await superDb.insert(schema.aiTask).values({
      id: createId('task'),
      orgId,
      employeeId: empFollow,
      type: 'follow_up',
      title: 'M3-01 占用并发（fixture）',
      status: 'running',
      startedAt: new Date(),
      input: {},
    });
    const resp = await tasksService.create(orgId, adminId, {
      employeeId: empFollow,
      type: 'follow_up',
      title: 'M3-01 直投回归·排队',
      input: {},
    });
    expect(resp.status).toBe('scheduled');
    const row = await readTask(resp.taskId);
    expect(row.status).toBe('scheduled');
    expect(row.startedAt).toBeNull();
    expect(await countPoison()).toBe(0);
  });

  it('未来定时任务：并发空闲也不直投（本应 delayed，04 §3.4）', async () => {
    const empResearch = await employeeIdOf('customer_researcher');
    const future = new Date(Date.now() + 60_000).toISOString();
    const resp = await tasksService.create(orgId, adminId, {
      employeeId: empResearch,
      type: 'business_analysis',
      title: 'M3-01 直投回归·未来定时',
      input: {},
      scheduledAt: future,
    });
    expect(resp.status).toBe('scheduled');
    const row = await readTask(resp.taskId);
    expect(row.status).toBe('scheduled');
    expect(row.scheduledAt).not.toBeNull();
    expect(row.scheduledAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await countPoison()).toBe(0);
  });
});

describe('retry 重试溯源（M3-02）', () => {
  it('retry 新任务落库 retry_of，detail 返回来源任务 id', async () => {
    const empFollow = await superDb
      .select({ id: schema.aiEmployee.id })
      .from(schema.aiEmployee)
      .where(and(eq(schema.aiEmployee.orgId, orgId), eq(schema.aiEmployee.role, 'follow_up')))
      .limit(1)
      .then((rows) => {
        if (!rows[0]) {
          throw new Error('种子员工缺失: follow_up');
        }
        return rows[0].id;
      });
    // fixture：失败源任务（retry 前置：仅 failed 可重试，14 §3.5）
    const sourceId = createId('task');
    await superDb.insert(schema.aiTask).values({
      id: sourceId,
      orgId,
      employeeId: empFollow,
      type: 'follow_up',
      title: 'M3-02 溯源·失败源任务',
      status: 'failed',
      error: 'fixture 失败',
      finishedAt: new Date(),
      input: { goal: 'M3-02 重试输入' },
    });

    const resp = await tasksService.retry(orgId, adminId, sourceId);
    expect(resp.taskId).not.toBe(sourceId);
    if (resp.status === 'running') {
      enqueued.push({ taskId: resp.taskId, type: 'follow_up' });
    }

    // 落库溯源：retry_of = 来源任务 id
    const [row] = await superDb
      .select({ retryOf: schema.aiTask.retryOf })
      .from(schema.aiTask)
      .where(eq(schema.aiTask.id, resp.taskId))
      .limit(1);
    expect(row?.retryOf).toBe(sourceId);

    // detail 聚合口径（14 §3.5）：retryOf 可回读
    const detail = await tasksService.detail(orgId, resp.taskId);
    expect(detail.retryOf).toBe(sourceId);
    expect(detail.input).toEqual({ goal: 'M3-02 重试输入' });
  });
});
