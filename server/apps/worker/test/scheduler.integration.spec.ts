import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import pino from 'pino';
import { releaseEmployeeIdle, type TaskEnqueuer } from '@tradepilot/runtime';
import { computeDeferredNextRunAt, createId } from '@tradepilot/core';
import { closeDb, createDb, schema, type Db } from '@tradepilot/db';
import { Dispatcher } from '../src/scheduler/dispatcher.js';
import { FollowUpScanner } from '../src/scheduler/follow-up-scanner.js';

/**
 * M3-17 调度器集成测试（后端技术方案 04 §3）：
 * - Dispatcher 并发闸门：员工并发=1（DB running/waiting_approval + 本轮累加，M3-06 挂起占员工位）、
 *   org 总并发=10（仅统计 running）、未到点定时任务不投、FIFO 投递；
 * - releaseEmployeeIdle 终态回写前置校验（M3-06）；
 * - FollowUpScanner 频控预检：频控不满足 → 顺延 + skipped(frequency_capped) 留痕不入队；
 *   预检通过 → 建 ai_task(scheduled)；活跃 ai_task 防重。
 * 前置：docker compose up（PG 5432）；调度扫描经 superDb（BYPASSRLS，与生产 tradepilot_sched 等效语义）。
 */

// 连接串可用 TEST_DB_URL 覆盖（如本机 5432 被占时用独立容器 5433）；默认指向 compose PG
const SUPER_URL =
  process.env.TEST_DB_URL ?? 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';
const logger: Logger = pino({ level: 'silent' });

let db: Db;

const ORG = createId('org');
const ORG_FULL = createId('org');
const USER = createId('usr');

/** 员工投递记录（stub enqueuer） */
const enqueued: { taskId: string; type: string }[] = [];
const stubEnqueuer = {
  enqueueTask: vi.fn(async (taskId: string, type: string) => {
    enqueued.push({ taskId, type });
  }),
  hasActiveJob: vi.fn(async () => false),
  removeTask: vi.fn(async () => undefined),
} as unknown as TaskEnqueuer;

let dispatcher: Dispatcher;
let scanner: FollowUpScanner;

// ===== 跟进场景固定 id =====
const EMP_FU = createId('aie');
const CUS_CAPPED = createId('cus');
const CUS_OK = createId('cus');
const CUS_BUSY = createId('cus');
const STRATEGY = createId('fstr');
const FT_CAPPED = createId('ftask');
const FT_OK = createId('ftask');
const FT_BUSY = createId('ftask');
const CONV_CAPPED = createId('conv');
const TASK_BUSY = createId('task');

// 租户 A 用前 5 个、租户 B 用后 11 个（切片必须不相交，否则 ai_employee 主键冲突）
const EMP_IDS = Array.from({ length: 16 }, () => createId('aie'));

async function insertTask(values: {
  orgId: string;
  employeeId: string;
  type?: 'lead_hunting' | 'follow_up' | 'email_reply';
  status: 'scheduled' | 'running' | 'waiting_approval' | 'completed';
  scheduledAt?: Date | null;
  input?: Record<string, unknown>;
}): Promise<string> {
  const id = createId('task');
  await db.insert(schema.aiTask).values({
    id,
    orgId: values.orgId,
    employeeId: values.employeeId,
    type: values.type ?? 'lead_hunting',
    title: `M3 测试任务 ${id}`,
    status: values.status,
    scheduledAt: values.scheduledAt ?? null,
    ...(values.input ? { input: values.input } : {}),
  });
  return id;
}

beforeAll(async () => {
  db = createDb(SUPER_URL, { max: 5 });
  dispatcher = new Dispatcher({ db, enqueuer: stubEnqueuer, logger });
  scanner = new FollowUpScanner({ db, logger });

  await db.transaction(async (tx) => {
    await tx.insert(schema.org).values([
      { id: ORG, name: 'M3调度租户A', timezone: 'Asia/Shanghai' },
      { id: ORG_FULL, name: 'M3调度租户B', timezone: 'Asia/Shanghai' },
    ]);
    await tx.insert(schema.userAccount).values({
      id: USER,
      orgId: ORG,
      email: `it-sched-${ORG}@test.com`,
      passwordHash: 'x',
      name: '调度测试管理员',
      role: 'admin',
      status: 'active',
    });
  });

  // ===== 租户 A：闸门语义 =====
  // emp[0]=有 1 running；emp[1]=空载 2 scheduled（本轮累加）；emp[2]=1 running + 1 scheduled；
  // emp[3]=1 waiting_approval + 1 scheduled（挂起占员工位，M3-06 → 不投）；emp[4]=未到点
  const now = Date.now();
  await db.insert(schema.aiEmployee).values(
    EMP_IDS.slice(0, 5).map((id, i) => ({
      id,
      orgId: ORG,
      role: 'sales' as const,
      name: `员工${i}`,
      goal: '测试',
      tools: [],
      permissions: {},
      approvalPolicy: {
        email_send: 'high_value_only' as const,
        quote: 'always' as const,
        autoExecute: [],
      },
      kpiConfig: [{ metric: 'leads', target: 1, period: 'daily' as const }],
    })),
  );
  await insertTask({ orgId: ORG, employeeId: EMP_IDS[0], status: 'running' });
  await insertTask({
    orgId: ORG,
    employeeId: EMP_IDS[1],
    status: 'scheduled',
    scheduledAt: new Date(now - 3000),
  });
  await insertTask({
    orgId: ORG,
    employeeId: EMP_IDS[1],
    status: 'scheduled',
    scheduledAt: new Date(now - 2000),
  });
  await insertTask({ orgId: ORG, employeeId: EMP_IDS[2], status: 'running' });
  await insertTask({
    orgId: ORG,
    employeeId: EMP_IDS[2],
    status: 'scheduled',
    scheduledAt: new Date(now - 1000),
  });
  await insertTask({ orgId: ORG, employeeId: EMP_IDS[3], status: 'waiting_approval' });
  await insertTask({
    orgId: ORG,
    employeeId: EMP_IDS[3],
    status: 'scheduled',
    scheduledAt: new Date(now - 500),
  });
  await insertTask({
    orgId: ORG,
    employeeId: EMP_IDS[4],
    status: 'scheduled',
    scheduledAt: new Date(now + 10 * 60_000),
  });

  // ===== 租户 B：org 并发=10（10 running 跨 10 员工 + 1 scheduled）=====
  await db.insert(schema.aiEmployee).values(
    EMP_IDS.slice(5).map((id, i) => ({
      id,
      orgId: ORG_FULL,
      role: 'sales' as const,
      name: `B员工${i}`,
      goal: '测试',
      tools: [],
      permissions: {},
      approvalPolicy: {
        email_send: 'high_value_only' as const,
        quote: 'always' as const,
        autoExecute: [],
      },
      kpiConfig: [{ metric: 'leads', target: 1, period: 'daily' as const }],
    })),
  );
  for (let i = 0; i < 10; i += 1) {
    await insertTask({ orgId: ORG_FULL, employeeId: EMP_IDS[i + 5], status: 'running' });
  }
  await insertTask({
    orgId: ORG_FULL,
    employeeId: EMP_IDS[15],
    status: 'scheduled',
    scheduledAt: new Date(now - 100),
  });

  // ===== 租户 A：跟进频控场景 =====
  await db.insert(schema.aiEmployee).values({
    id: EMP_FU,
    orgId: ORG,
    role: 'follow_up' as const,
    name: '跟进员',
    goal: '测试',
    tools: [],
    permissions: {},
    approvalPolicy: {
      email_send: 'high_value_only' as const,
      quote: 'always' as const,
      autoExecute: [],
    },
    kpiConfig: [{ metric: 'touches', target: 1, period: 'daily' as const }],
  });
  await db.insert(schema.customer).values([
    { id: CUS_CAPPED, orgId: ORG, companyName: '频控客户', country: 'US', ownerId: USER },
    { id: CUS_OK, orgId: ORG, companyName: '到期客户', country: 'US', ownerId: USER },
    { id: CUS_BUSY, orgId: ORG, companyName: '防重客户', country: 'US', ownerId: USER },
  ]);
  await db.insert(schema.followUpStrategy).values({
    id: STRATEGY,
    orgId: ORG,
    name: '调度测试策略',
    targetScope: {},
    autoSendPolicy: 'manual_review',
  });
  const due = new Date(Date.now() - 60_000);
  await db.insert(schema.followUpTask).values([
    {
      id: FT_CAPPED,
      orgId: ORG,
      customerId: CUS_CAPPED,
      strategyId: STRATEGY,
      status: 'scheduled',
      nextRunAt: due,
    },
    {
      id: FT_OK,
      orgId: ORG,
      customerId: CUS_OK,
      strategyId: STRATEGY,
      status: 'ready',
      nextRunAt: due,
    },
    {
      id: FT_BUSY,
      orgId: ORG,
      customerId: CUS_BUSY,
      strategyId: STRATEGY,
      status: 'scheduled',
      nextRunAt: due,
    },
  ]);
  // 频控不满足：1 天前刚人工外发过（L + 3d > next_run_at）
  await db.insert(schema.conversation).values({
    id: CONV_CAPPED,
    orgId: ORG,
    customerId: CUS_CAPPED,
    channel: 'email',
    subject: '频控会话',
  });
  await db.insert(schema.message).values({
    id: createId('msg'),
    orgId: ORG,
    conversationId: CONV_CAPPED,
    direction: 'out',
    senderType: 'user',
    senderName: '销售',
    content: 'hello',
    status: 'sent',
    sentAt: new Date(Date.now() - 86_400_000),
    createdAt: new Date(Date.now() - 86_400_000),
  });
  // 防重：该跟进任务已有活跃 ai_task
  await db.insert(schema.aiTask).values({
    id: TASK_BUSY,
    orgId: ORG,
    employeeId: EMP_FU,
    type: 'follow_up',
    title: '既有跟进任务',
    status: 'scheduled',
    input: { followUpTaskId: FT_BUSY, customerId: CUS_BUSY },
  });
});

afterAll(async () => {
  const orgIds = [ORG, ORG_FULL];
  await db.transaction(async (tx) => {
    await tx.delete(schema.aiTask).where(inArray(schema.aiTask.orgId, orgIds));
    await tx
      .delete(schema.followUpExecution)
      .where(inArray(schema.followUpExecution.orgId, orgIds));
    await tx.delete(schema.followUpTask).where(inArray(schema.followUpTask.orgId, orgIds));
    await tx.delete(schema.followUpStrategy).where(inArray(schema.followUpStrategy.orgId, orgIds));
    await tx.delete(schema.message).where(inArray(schema.message.orgId, orgIds));
    await tx.delete(schema.conversation).where(inArray(schema.conversation.orgId, orgIds));
    await tx.delete(schema.customer).where(inArray(schema.customer.orgId, orgIds));
    await tx.delete(schema.aiEmployee).where(inArray(schema.aiEmployee.orgId, orgIds));
    await tx.delete(schema.userAccount).where(inArray(schema.userAccount.orgId, orgIds));
    await tx.delete(schema.org).where(inArray(schema.org.id, orgIds));
  });
  await closeDb(db);
});

describe('Dispatcher 并发闸门（04 §3.3）', () => {
  it('员工并发=1 / 本轮累加 / waiting_approval 占员工位 / 未到点不投 / FIFO', async () => {
    enqueued.length = 0;
    const dispatched = await dispatcher.tick();

    // 期望投递：emp[1] 队首任务（FIFO 早者）
    // 不投：emp[0]（无 scheduled）、emp[2]（DB running 占用）、emp[3]（waiting_approval 占员工位，M3-06）、emp[4]（未到点）
    expect(dispatched).toBe(1);
    expect(enqueued).toHaveLength(1);

    // emp[1] 只投队首（本轮累加：投递后 empUsed=1，同员工第二个任务不投）
    const emp1Tasks = await db
      .select({ id: schema.aiTask.id })
      .from(schema.aiTask)
      .where(
        and(
          eq(schema.aiTask.orgId, ORG),
          eq(schema.aiTask.employeeId, EMP_IDS[1]),
          eq(schema.aiTask.status, 'scheduled'),
        ),
      )
      .orderBy(asc(schema.aiTask.scheduledAt));
    expect(emp1Tasks).toHaveLength(2);
    const dispatchedIds = enqueued.map((e) => e.taskId);
    expect(dispatchedIds).toContain(emp1Tasks[0]!.id);
    expect(dispatchedIds).not.toContain(emp1Tasks[1]!.id);

    // emp[2]（有 running）、emp[3]（waiting_approval 占员工位）与 emp[4]（未到点）的 scheduled 保持不动
    for (const empId of [EMP_IDS[2], EMP_IDS[3], EMP_IDS[4]]) {
      const rows = await db
        .select({ status: schema.aiTask.status })
        .from(schema.aiTask)
        .where(
          and(
            eq(schema.aiTask.orgId, ORG),
            eq(schema.aiTask.employeeId, empId),
            eq(schema.aiTask.status, 'scheduled'),
          ),
        );
      expect(rows.length).toBeGreaterThan(0);
    }
  });

  it('org 并发=10：满载不投，腾出一个名额后恢复投递', async () => {
    enqueued.length = 0;
    // 隔离租户 A 的闸门样本（置 completed，避免 stub 不置 running 导致的重复可投与 B 并发断言耦合）
    await db
      .update(schema.aiTask)
      .set({ status: 'completed' })
      .where(
        and(eq(schema.aiTask.orgId, ORG), inArray(schema.aiTask.employeeId, EMP_IDS.slice(0, 5))),
      );
    // 租户 B 10 个 running 已满 → B 的 scheduled 不投；A 已清空 → 本轮 0 投递
    const dispatched1 = await dispatcher.tick();
    expect(dispatched1).toBe(0);

    // 释放一个名额（RF1 完成）
    const [runningTask] = await db
      .select({ id: schema.aiTask.id })
      .from(schema.aiTask)
      .where(and(eq(schema.aiTask.orgId, ORG_FULL), eq(schema.aiTask.status, 'running')))
      .limit(1);
    await db
      .update(schema.aiTask)
      .set({ status: 'completed' })
      .where(eq(schema.aiTask.id, runningTask!.id));

    enqueued.length = 0;
    const dispatched2 = await dispatcher.tick();
    expect(dispatched2).toBe(1);
    expect(enqueued[0]?.type).toBe('lead_hunting');
    const [releasedTask] = await db
      .select({ id: schema.aiTask.id })
      .from(schema.aiTask)
      .where(and(eq(schema.aiTask.orgId, ORG_FULL), eq(schema.aiTask.status, 'scheduled')))
      .limit(1);
    // 投递后任务行仍为 scheduled（置 running 由 TaskRunner.claim 唯一执行）
    expect(enqueued[0]?.taskId).toBe(releasedTask?.id);
  });
});

describe('releaseEmployeeIdle 终态回写前置校验（04 §3.3 / M3-06）', () => {
  it('员工仍占用其它 active 任务 → 不回 idle，保持现状态', async () => {
    const empId = createId('aie');
    const keepId = createId('task');
    const finishId = createId('task');
    const outcome = await db.transaction(async (tx) => {
      await tx.insert(schema.aiEmployee).values({
        id: empId,
        orgId: ORG,
        role: 'sales',
        name: '释放校验A',
        goal: '测试',
        tools: [],
        permissions: {},
        approvalPolicy: {
          email_send: 'high_value_only' as const,
          quote: 'always' as const,
          autoExecute: [],
        },
        kpiConfig: [{ metric: 'leads', target: 1, period: 'daily' as const }],
        status: 'working',
      });
      await tx.insert(schema.aiTask).values([
        {
          id: keepId,
          orgId: ORG,
          employeeId: empId,
          type: 'lead_hunting',
          title: '占用任务',
          status: 'running',
        },
        {
          id: finishId,
          orgId: ORG,
          employeeId: empId,
          type: 'lead_hunting',
          title: '刚终态任务',
          status: 'running',
        },
      ]);
      const released = await releaseEmployeeIdle(tx, {
        employeeId: empId,
        excludeTaskId: finishId,
        now: new Date(),
      });
      const [emp] = await tx
        .select({ status: schema.aiEmployee.status })
        .from(schema.aiEmployee)
        .where(eq(schema.aiEmployee.id, empId));
      return { released, status: emp?.status };
    });
    // 排除刚终态的任务后仍有其它 running → 保持员工状态（防「任务 A 结束把跑 B 的员工置 idle」）
    expect(outcome.released).toBe(false);
    expect(outcome.status).toBe('working');
  });

  it('员工无其它 active 任务 → 回写 idle', async () => {
    const empId = createId('aie');
    const finishId = createId('task');
    const outcome = await db.transaction(async (tx) => {
      await tx.insert(schema.aiEmployee).values({
        id: empId,
        orgId: ORG,
        role: 'sales',
        name: '释放校验B',
        goal: '测试',
        tools: [],
        permissions: {},
        approvalPolicy: {
          email_send: 'high_value_only' as const,
          quote: 'always' as const,
          autoExecute: [],
        },
        kpiConfig: [{ metric: 'leads', target: 1, period: 'daily' as const }],
        status: 'waiting_approval',
      });
      await tx.insert(schema.aiTask).values({
        id: finishId,
        orgId: ORG,
        employeeId: empId,
        type: 'lead_hunting',
        title: '唯一任务',
        status: 'running',
      });
      const released = await releaseEmployeeIdle(tx, {
        employeeId: empId,
        excludeTaskId: finishId,
        now: new Date(),
      });
      const [emp] = await tx
        .select({ status: schema.aiEmployee.status })
        .from(schema.aiEmployee)
        .where(eq(schema.aiEmployee.id, empId));
      return { released, status: emp?.status };
    });
    expect(outcome.released).toBe(true);
    expect(outcome.status).toBe('idle');
  });
});

describe('FollowUpScanner 频控预检（04 §3.2 / 07 §7）', () => {
  it('频控不满足 → 顺延 + skipped(frequency_capped) 留痕，不入队且不再被扫描', async () => {
    const [before] = await db
      .select({ nextRunAt: schema.followUpTask.nextRunAt })
      .from(schema.followUpTask)
      .where(eq(schema.followUpTask.id, FT_CAPPED));
    const result = await scanner.tick();
    expect(result.deferred).toBe(1);
    expect(result.enqueued).toBe(0);

    const [after] = await db
      .select({ nextRunAt: schema.followUpTask.nextRunAt, status: schema.followUpTask.status })
      .from(schema.followUpTask)
      .where(eq(schema.followUpTask.id, FT_CAPPED));
    expect(after.status).toBe('scheduled');
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(before!.nextRunAt!.getTime());
    // 与 Scheduler/图内共用的唯一公式（P1-4）：候选 = max(next_run_at, L + 3d) → 窗口对齐
    const expected = computeDeferredNextRunAt({
      now: new Date(),
      nextRunAt: before!.nextRunAt!,
      lastOutboundAt: new Date(Date.now() - 86_400_000),
      minTouchIntervalDays: 3,
      timeZone: 'Asia/Shanghai',
    });
    expect(Math.abs(after.nextRunAt!.getTime() - expected.getTime())).toBeLessThan(60_000);

    const execs = await db
      .select({
        status: schema.followUpExecution.status,
        skipReason: schema.followUpExecution.skipReason,
      })
      .from(schema.followUpExecution)
      .where(eq(schema.followUpExecution.followUpTaskId, FT_CAPPED));
    expect(execs).toHaveLength(1);
    expect(execs[0].status).toBe('skipped');
    expect(execs[0].skipReason).toBe('frequency_capped');

    // 不入队：无该任务的活跃 ai_task
    const tasks = await db
      .select({ id: schema.aiTask.id })
      .from(schema.aiTask)
      .where(sql`(${schema.aiTask.input} ->> 'followUpTaskId') = ${FT_CAPPED}`);
    expect(tasks).toHaveLength(0);

    // 顺延后 next_run_at 前移出扫描窗口 → 下轮不再扫描
    const second = await scanner.tick();
    expect(second.scanned).toBe(0);
  });

  it('预检通过 → 建 follow_up ai_task(scheduled)，无会话则补建会话', async () => {
    const result = await scanner.tick();
    expect(result.enqueued).toBe(1);

    const [task] = await db
      .select({
        id: schema.aiTask.id,
        employeeId: schema.aiTask.employeeId,
        status: schema.aiTask.status,
        input: schema.aiTask.input,
      })
      .from(schema.aiTask)
      .where(sql`(${schema.aiTask.input} ->> 'followUpTaskId') = ${FT_OK}`);
    expect(task.status).toBe('scheduled');
    expect(task.employeeId).toBe(EMP_FU);
    expect(task.input['customerId']).toBe(CUS_OK);

    const convs = await db
      .select({ id: schema.conversation.id })
      .from(schema.conversation)
      .where(and(eq(schema.conversation.orgId, ORG), eq(schema.conversation.customerId, CUS_OK)));
    expect(convs).toHaveLength(1);
  });

  it('活跃 ai_task 防重：已有 scheduled 任务时跳过（busy），不重复建任务', async () => {
    const result = await scanner.tick();
    const tasks = await db
      .select({ id: schema.aiTask.id })
      .from(schema.aiTask)
      .where(sql`(${schema.aiTask.input} ->> 'followUpTaskId') = ${FT_BUSY}`);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe(TASK_BUSY);
    expect(result.enqueued).toBe(0);
  });

  it('M3-04 多实例并发预检不重复建 ai_task（行锁 SKIP LOCKED + 唯一索引兜底）', async () => {
    // 新增一条到期跟进任务（无既有会话/外发 → 频控通过），双实例并发各自 tick
    const CUS_RACE = createId('cus');
    const FT_RACE = createId('ftask');
    await db.insert(schema.customer).values({
      id: CUS_RACE,
      orgId: ORG,
      companyName: '并发竞态客户',
      country: 'US',
      ownerId: USER,
    });
    await db.insert(schema.followUpTask).values({
      id: FT_RACE,
      orgId: ORG,
      customerId: CUS_RACE,
      strategyId: STRATEGY,
      status: 'ready',
      nextRunAt: new Date(Date.now() - 60_000),
    });

    // 模拟第二个 worker 实例（同库、独立扫描器）
    const scanner2 = new FollowUpScanner({ db, logger });
    const [a, b] = await Promise.all([scanner.tick(), scanner2.tick()]);

    // 无论调度交错如何，同一 followUpTaskId 只允许一条活跃 ai_task
    const tasks = await db
      .select({ id: schema.aiTask.id, status: schema.aiTask.status })
      .from(schema.aiTask)
      .where(sql`(${schema.aiTask.input} ->> 'followUpTaskId') = ${FT_RACE}`);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe('scheduled');
    expect(a.enqueued + b.enqueued).toBe(1);

    // 行锁串行化后败者让出：无孤儿会话产生
    const convs = await db
      .select({ id: schema.conversation.id })
      .from(schema.conversation)
      .where(and(eq(schema.conversation.orgId, ORG), eq(schema.conversation.customerId, CUS_RACE)));
    expect(convs).toHaveLength(1);
  });
});
