import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { inArray, sql } from 'drizzle-orm';
import pino from 'pino';
import type { Logger } from 'pino';
import type { TaskEnqueuer } from '@tradepilot/runtime';
import { createId } from '@tradepilot/core';
import { closeDb, createDb, schema, type Db } from '@tradepilot/db';
import { DelayedJobReconciler } from '../src/scheduler/delayed-reconciler.js';

/**
 * DelayedJobReconciler 独立 spec（后端技术方案 04 §3.1/§3.4 / M4 启动清单 A3，M3-T2 测试缺口）：
 * - 到期（scheduled_at ≤ now）+ status='scheduled' + BullMQ 无活跃 job → 补投（jobId=taskId 幂等）；
 * - BullMQ 活跃 job 存在 → 跳过；
 * - 员工占用闸门（running/waiting_approval 占员工位，M3-06 同口径）→ 保持 scheduled；
 * - org running ≥ 10 → 保持 scheduled；
 * - 未到期 → 不进入扫描。
 * 前置：docker compose up（PG 5432）；扫描经 superDb（BYPASSRLS）。
 */

const SUPER_URL =
  process.env.TEST_DB_URL ?? 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';
const logger: Logger = pino({ level: 'silent' });

let db: Db;

const ORG = createId('org');
const ORG_FULL = createId('org');
const USER = createId('usr');

const enqueued = new Map<string, string>();
const enqueuer = {
  hasActiveJob: vi.fn(async () => false),
  enqueueTask: vi.fn(async (taskId: string, type: string) => {
    enqueued.set(taskId, type);
  }),
} as unknown as TaskEnqueuer;

let reconciler: DelayedJobReconciler;

// 租户 A：单员工场景；租户 B：org 满载场景（10 running + 1 due scheduled）
const EMP = createId('aie');
const EMP_HAS_JOB = createId('aie');
const EMP_BUSY = createId('aie');
const EMP_WA = createId('aie');
const TASK_OK = createId('task');
const TASK_HAS_JOB = createId('task');
const TASK_EMP_BUSY = createId('task');
const TASK_EMP_WA = createId('task');
const TASK_FUTURE = createId('task');
const EMP_IDS_FULL = Array.from({ length: 11 }, () => createId('aie'));
const TASK_DUE_FULL = createId('task');

async function insertEmployee(values: { id: string; orgId: string; name: string }): Promise<void> {
  await db.insert(schema.aiEmployee).values({
    id: values.id,
    orgId: values.orgId,
    role: 'sales' as const,
    name: values.name,
    goal: '测试',
    tools: [],
    permissions: {},
    approvalPolicy: {
      email_send: 'high_value_only' as const,
      quote: 'always' as const,
      autoExecute: [],
    },
    kpiConfig: [{ metric: 'leads', target: 1, period: 'daily' as const }],
  });
}

async function insertTask(values: {
  id: string;
  orgId: string;
  employeeId: string;
  status: 'scheduled' | 'running' | 'waiting_approval';
  scheduledAt?: Date | null;
  title: string;
}): Promise<void> {
  await db.insert(schema.aiTask).values({
    id: values.id,
    orgId: values.orgId,
    employeeId: values.employeeId,
    type: 'lead_hunting',
    title: values.title,
    status: values.status,
    scheduledAt: values.scheduledAt ?? null,
  });
}

const due = new Date(Date.now() - 60_000);

beforeAll(async () => {
  db = createDb(SUPER_URL, { max: 5 });
  reconciler = new DelayedJobReconciler({ db, enqueuer, logger });

  // 跨租户扫描器对 DB 残留敏感：全局清表保干净基线
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`TRUNCATE TABLE ai_task, ai_task_log, ai_task_step RESTART IDENTITY CASCADE`,
    );
  });

  await db.transaction(async (tx) => {
    await tx.insert(schema.org).values([
      { id: ORG, name: 'M4-A3 对账租户A', timezone: 'Asia/Shanghai' },
      { id: ORG_FULL, name: 'M4-A3 对账租户B', timezone: 'Asia/Shanghai' },
    ]);
    await tx.insert(schema.userAccount).values({
      id: USER,
      orgId: ORG,
      email: `it-reconcile-${ORG}@test.com`,
      passwordHash: 'x',
      name: '对账测试管理员',
      role: 'admin',
      status: 'active',
    });
  });

  await insertEmployee({ id: EMP, orgId: ORG, name: '空闲员工' });
  await insertEmployee({ id: EMP_HAS_JOB, orgId: ORG, name: '有job员工' });
  await insertEmployee({ id: EMP_BUSY, orgId: ORG, name: '占用员工' });
  await insertEmployee({ id: EMP_WA, orgId: ORG, name: '挂起员工' });
  for (const [i, id] of EMP_IDS_FULL.entries()) {
    await insertEmployee({ id, orgId: ORG_FULL, name: `B员工${i}` });
  }

  await insertTask({
    id: TASK_OK,
    orgId: ORG,
    employeeId: EMP,
    status: 'scheduled',
    scheduledAt: due,
    title: 'A3 应补投任务',
  });
  await insertTask({
    id: TASK_HAS_JOB,
    orgId: ORG,
    employeeId: EMP_HAS_JOB,
    status: 'scheduled',
    scheduledAt: due,
    title: 'A3 活跃job存在任务',
  });
  await insertTask({
    id: TASK_EMP_BUSY,
    orgId: ORG,
    employeeId: EMP_BUSY,
    status: 'scheduled',
    scheduledAt: due,
    title: 'A3 员工占用任务',
  });
  await insertTask({
    id: TASK_EMP_WA,
    orgId: ORG,
    employeeId: EMP_WA,
    status: 'scheduled',
    scheduledAt: due,
    title: 'A3 员工挂起任务',
  });
  await insertTask({
    id: TASK_FUTURE,
    orgId: ORG,
    employeeId: EMP,
    status: 'scheduled',
    scheduledAt: new Date(Date.now() + 10 * 60_000),
    title: 'A3 未到期任务',
  });
  // 占用闸门 fixture
  await insertTask({
    id: createId('task'),
    orgId: ORG,
    employeeId: EMP_BUSY,
    status: 'running',
    title: 'A3 占用中的运行任务',
  });
  await insertTask({
    id: createId('task'),
    orgId: ORG,
    employeeId: EMP_WA,
    status: 'waiting_approval',
    title: 'A3 挂起占位任务',
  });
  // 租户 B：10 running 占满 org 并发 + 1 到期 scheduled
  for (const [i, id] of EMP_IDS_FULL.slice(0, 10).entries()) {
    await insertTask({
      id: createId('task'),
      orgId: ORG_FULL,
      employeeId: id,
      status: 'running',
      title: `B running ${i}`,
    });
  }
  await insertTask({
    id: TASK_DUE_FULL,
    orgId: ORG_FULL,
    employeeId: EMP_IDS_FULL[10]!,
    status: 'scheduled',
    scheduledAt: due,
    title: 'B org 满载到期任务',
  });
});

afterAll(async () => {
  await db.transaction(async (tx) => {
    const orgIds = [ORG, ORG_FULL];
    await tx.delete(schema.aiTask).where(inArray(schema.aiTask.orgId, orgIds));
    await tx.delete(schema.aiEmployee).where(inArray(schema.aiEmployee.orgId, orgIds));
    await tx.delete(schema.userAccount).where(inArray(schema.userAccount.orgId, orgIds));
    await tx.delete(schema.org).where(inArray(schema.org.id, orgIds));
  });
  await closeDb(db);
});

describe('DelayedJobReconciler（04 §3.1/§3.4）', () => {
  it('到期 + 无活跃 job + 员工空闲 → 补投（jobId=taskId，类型入对应队列）', async () => {
    const requeued = await reconciler.tick();
    // 仅 TASK_OK 通过（其余分别命中 job 存在 / 员工占用 / 挂起占位 / org 满载 / 未到期）
    expect(requeued).toBe(1);
    expect(enqueuer.enqueueTask).toHaveBeenCalledWith(TASK_OK, 'lead_hunting');
    expect(enqueued.get(TASK_OK)).toBe('lead_hunting');
  });

  it('BullMQ 活跃 job 存在 → 跳过补投', async () => {
    expect(enqueued.has(TASK_HAS_JOB)).toBe(false);
    const [row] = await db
      .select({ status: schema.aiTask.status })
      .from(schema.aiTask)
      .where(sql`${schema.aiTask.id} = ${TASK_HAS_JOB}`);
    expect(row?.status).toBe('scheduled');
  });

  it('员工占用闸门：running 占用与 waiting_approval 占位（M3-06 同口径）→ 均不补投', async () => {
    expect(enqueued.has(TASK_EMP_BUSY)).toBe(false);
    expect(enqueued.has(TASK_EMP_WA)).toBe(false);
  });

  it('org 并发满载（running ≥ 10）→ 保持 scheduled 不补投', async () => {
    expect(enqueued.has(TASK_DUE_FULL)).toBe(false);
  });

  it('未到期任务不进入扫描', async () => {
    expect(enqueued.has(TASK_FUTURE)).toBe(false);
  });

  it('幂等：同任务补投后（job 出现）下轮跳过，不重复投递', async () => {
    // 模拟 TASK_OK 已有活跃 job（补投成功后的正常态）
    vi.mocked(enqueuer.hasActiveJob).mockImplementation(async (taskId) => taskId === TASK_OK);
    try {
      const requeued = await reconciler.tick();
      expect(requeued).toBe(0);
      expect(enqueuer.enqueueTask).toHaveBeenCalledTimes(1); // 仅首轮那一次
    } finally {
      vi.mocked(enqueuer.hasActiveJob).mockImplementation(async () => false);
    }
  });
});
