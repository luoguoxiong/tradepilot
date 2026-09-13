import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { createId } from '@tradepilot/core';
import { closeDb, createDb, schema, type Db } from '@tradepilot/db';
import { TaskEnqueuer } from '@tradepilot/runtime';
import {
  SSE_EVENT_TYPE,
  TASK_STATUS,
  taskEventChannel,
  type TaskStatus,
  type TaskType,
} from '@tradepilot/shared';
import { EnvService } from '../src/config/env.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { TokenService } from '../src/auth/token.service.js';
import { TasksService } from '../src/tasks/tasks.service.js';

/**
 * 任务中心操作集成测试（P1-X-30~33 / 接口 14 §3.6~3.7 / 技术方案 04 §5.4）：
 * - pause/resume/cancel 状态机 + 员工位/日志联动（paused 不占并发）；
 * - resume 语义分流：已产生检查点 → running + fromPause 重投（Runner invoke(null) 续跑）；
 *   从未执行（暂停于 scheduled）→ scheduled 由 Dispatcher 全新投递；
 * - transfer-to-human：暂停图 + outputs 追加 handoff 交接摘要；
 * - 失败批量处理：多选 retry / transfer，逐条回传结果；
 * - SSE：操作后推 status（cancel 另推 done）收口前端流。
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
let empId = '';
const adminEmail = `it-tasks-ops-${createId('org')}@test.com`;

interface RecordedEvent {
  type: string;
  seq: string;
  payload: Record<string, unknown>;
}

/** 订阅任务事件频道并收集消息（操作前订阅，防丢事件） */
async function collectEvents(
  taskId: string,
): Promise<{ events: RecordedEvent[]; close: () => Promise<void> }> {
  const events: RecordedEvent[] = [];
  const sub = redis.duplicate();
  await sub.subscribe(taskEventChannel(taskId));
  sub.on('message', (_channel, raw) => {
    events.push(JSON.parse(raw) as RecordedEvent);
  });
  return {
    events,
    close: async () => {
      await sub.quit();
    },
  };
}

async function waitUntil(
  events: RecordedEvent[],
  pred: (e: RecordedEvent) => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (events.some(pred)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`等待事件超时：${JSON.stringify(events)}`);
}

async function readTask(taskId: string): Promise<{
  status: TaskStatus;
  startedAt: Date | null;
  finishedAt: Date | null;
  outputs: Record<string, unknown>[] | null;
}> {
  const [row] = await superDb
    .select({
      status: schema.aiTask.status,
      startedAt: schema.aiTask.startedAt,
      finishedAt: schema.aiTask.finishedAt,
      outputs: schema.aiTask.outputs,
    })
    .from(schema.aiTask)
    .where(eq(schema.aiTask.id, taskId))
    .limit(1);
  if (!row) {
    throw new Error(`任务不存在: ${taskId}`);
  }
  return {
    status: row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    outputs: (row.outputs ?? null) as Record<string, unknown>[] | null,
  };
}

async function readEmployeeStatus(): Promise<string> {
  const [row] = await superDb
    .select({ status: schema.aiEmployee.status })
    .from(schema.aiEmployee)
    .where(eq(schema.aiEmployee.id, empId))
    .limit(1);
  return row?.status ?? '';
}

async function countLogs(taskId: string): Promise<number> {
  const rows = await superDb
    .select({ id: schema.aiTaskLog.id })
    .from(schema.aiTaskLog)
    .where(and(eq(schema.aiTaskLog.taskId, taskId), eq(schema.aiTaskLog.type, 'error')));
  return rows.length;
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

  const session = await auth.register({
    companyName: 'IT 任务中心操作租户',
    contactName: '管理员',
    email: adminEmail,
    password: 'password123',
  });
  orgId = session.user.orgId;
  adminId = session.user.userId;

  const [emp] = await superDb
    .select({ id: schema.aiEmployee.id })
    .from(schema.aiEmployee)
    .where(and(eq(schema.aiEmployee.orgId, orgId), eq(schema.aiEmployee.role, 'lead_hunter')))
    .limit(1);
  if (!emp) {
    throw new Error('种子员工缺失: lead_hunter');
  }
  empId = emp.id;
}, 30_000);

afterAll(async () => {
  if (orgId) {
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

describe('P1-X-30 pause/resume/cancel', () => {
  it('暂停执行中任务：running→paused、员工释放 idle、推 SSE status=paused；恢复从检查点续跑', async () => {
    const taskId = createId('task');
    await superDb.insert(schema.aiTask).values({
      id: taskId,
      orgId,
      employeeId: empId,
      type: 'lead_hunting',
      title: 'X-30 暂停/恢复·执行中',
      status: TASK_STATUS.RUNNING,
      startedAt: new Date(),
      input: {},
    });
    await superDb
      .update(schema.aiEmployee)
      .set({ status: 'working' })
      .where(eq(schema.aiEmployee.id, empId));

    const { events, close } = await collectEvents(taskId);
    try {
      const paused = await tasksService.pause(orgId, taskId);
      expect(paused.status).toBe(TASK_STATUS.PAUSED);
      const rowPaused = await readTask(taskId);
      expect(rowPaused.status).toBe(TASK_STATUS.PAUSED);
      expect(await readEmployeeStatus()).toBe('idle');
      await waitUntil(
        events,
        (e) => e.type === SSE_EVENT_TYPE.STATUS && e.payload['status'] === 'paused',
      );
    } finally {
      await close();
    }

    // 幂等：重复暂停不报错、不加日志
    const logsAfterPause = await countLogs(taskId);
    await tasksService.pause(orgId, taskId);
    expect(await countLogs(taskId)).toBe(logsAfterPause);

    // 恢复：已产生检查点（started_at 非空）→ running + fromCheckpoint；按 fromPause 重投队列
    const { events: resumeEvents, close: closeResume } = await collectEvents(taskId);
    try {
      const resumed = await tasksService.resume(orgId, taskId);
      expect(resumed.status).toBe(TASK_STATUS.RUNNING);
      expect(resumed.fromCheckpoint).toBe(true);
      const rowResumed = await readTask(taskId);
      expect(rowResumed.status).toBe(TASK_STATUS.RUNNING);
      expect(rowResumed.startedAt).not.toBeNull();
      expect(await readEmployeeStatus()).toBe('working');
      await waitUntil(
        resumeEvents,
        (e) => e.type === SSE_EVENT_TYPE.STATUS && e.payload['status'] === 'running',
      );
    } finally {
      await closeResume();
    }
    // 移除重投 job，避免 dev worker 消费本用例制造的「无检查点」任务（best-effort）
    await probeEnqueuer.removeTask(taskId, 'lead_hunting' as TaskType).catch(() => undefined);
  });

  it('暂停未执行任务：scheduled→paused；恢复重新排队（scheduled，非检查点续跑）', async () => {
    const taskId = createId('task');
    await superDb.insert(schema.aiTask).values({
      id: taskId,
      orgId,
      employeeId: empId,
      type: 'lead_hunting',
      title: 'X-30 暂停/恢复·未执行',
      status: TASK_STATUS.SCHEDULED,
      input: {},
    });

    const paused = await tasksService.pause(orgId, taskId);
    expect(paused.status).toBe(TASK_STATUS.PAUSED);
    expect((await readTask(taskId)).status).toBe(TASK_STATUS.PAUSED);

    const resumed = await tasksService.resume(orgId, taskId);
    expect(resumed.status).toBe(TASK_STATUS.SCHEDULED);
    expect(resumed.fromCheckpoint).toBe(false);
    expect((await readTask(taskId)).status).toBe(TASK_STATUS.SCHEDULED);
  });

  it('取消执行中任务：→canceled（终态）、补 finished_at、员工释放、推 status+done', async () => {
    const taskId = createId('task');
    await superDb.insert(schema.aiTask).values({
      id: taskId,
      orgId,
      employeeId: empId,
      type: 'lead_hunting',
      title: 'X-30 取消',
      status: TASK_STATUS.RUNNING,
      startedAt: new Date(),
      input: {},
    });
    await superDb
      .update(schema.aiEmployee)
      .set({ status: 'working' })
      .where(eq(schema.aiEmployee.id, empId));

    const { events, close } = await collectEvents(taskId);
    try {
      const canceled = await tasksService.cancel(orgId, taskId);
      expect(canceled.status).toBe(TASK_STATUS.CANCELED);
      const row = await readTask(taskId);
      expect(row.status).toBe(TASK_STATUS.CANCELED);
      expect(row.finishedAt).not.toBeNull();
      expect(await readEmployeeStatus()).toBe('idle');
      await waitUntil(
        events,
        (e) => e.type === SSE_EVENT_TYPE.STATUS && e.payload['status'] === 'canceled',
      );
      await waitUntil(
        events,
        (e) => e.type === SSE_EVENT_TYPE.DONE && e.payload['status'] === 'canceled',
      );
    } finally {
      await close();
    }
  });

  it('状态守卫：completed 不可暂停；waiting_approval 不可取消（审批中心处置）', async () => {
    const completedId = createId('task');
    await superDb.insert(schema.aiTask).values({
      id: completedId,
      orgId,
      employeeId: empId,
      type: 'lead_hunting',
      title: 'X-30 守卫·completed',
      status: TASK_STATUS.COMPLETED,
      finishedAt: new Date(),
      input: {},
    });
    await expect(tasksService.pause(orgId, completedId)).rejects.toThrow(
      /仅执行中\/已排期任务可暂停/,
    );

    const approvalId = createId('task');
    await superDb.insert(schema.aiTask).values({
      id: approvalId,
      orgId,
      employeeId: empId,
      type: 'lead_hunting',
      title: 'X-30 守卫·waiting_approval',
      status: TASK_STATUS.WAITING_APPROVAL,
      input: {},
    });
    await expect(tasksService.cancel(orgId, approvalId)).rejects.toThrow(
      /仅执行中\/已排队\/已暂停任务可取消/,
    );
  });
});

describe('P1-X-31 transfer-to-human', () => {
  it('执行中转人工：置 paused 中断图 + 追加 handoff 交接摘要 + 员工释放', async () => {
    const taskId = createId('task');
    await superDb.insert(schema.aiTask).values({
      id: taskId,
      orgId,
      employeeId: empId,
      type: 'lead_hunting',
      title: 'X-31 转人工·执行中',
      status: TASK_STATUS.RUNNING,
      startedAt: new Date(),
      outputs: [{ type: 'draft', payload: { ok: true } }],
      input: {},
    });
    await superDb
      .update(schema.aiEmployee)
      .set({ status: 'working' })
      .where(eq(schema.aiEmployee.id, empId));

    const result = await tasksService.transferToHuman(orgId, adminId, taskId, {
      reason: '客户要求人工沟通',
      assignee: '张三',
    });
    expect(result.status).toBe(TASK_STATUS.PAUSED);
    const row = await readTask(taskId);
    expect(row.status).toBe(TASK_STATUS.PAUSED);
    expect(await readEmployeeStatus()).toBe('idle');
    // outputs append：既有草稿保留 + 追加 handoff 摘要
    expect(row.outputs?.some((o) => o['type'] === 'draft')).toBe(true);
    const handoff = row.outputs?.find((o) => o['type'] === 'handoff');
    expect(handoff).toBeTruthy();
    const payload = handoff?.['payload'] as Record<string, unknown>;
    expect(payload['fromStatus']).toBe('running');
    expect(payload['reason']).toBe('客户要求人工沟通');
    expect(payload['assignee']).toBe('张三');
    expect(payload['transferredBy']).toBe(adminId);
  });

  it('失败任务转人工：保持 failed，仅追加交接摘要', async () => {
    const taskId = createId('task');
    await superDb.insert(schema.aiTask).values({
      id: taskId,
      orgId,
      employeeId: empId,
      type: 'lead_hunting',
      title: 'X-31 转人工·失败',
      status: TASK_STATUS.FAILED,
      error: 'fixture 失败',
      finishedAt: new Date(),
      input: {},
    });

    const result = await tasksService.transferToHuman(orgId, adminId, taskId, {});
    expect(result.status).toBe(TASK_STATUS.FAILED);
    const row = await readTask(taskId);
    expect(row.status).toBe(TASK_STATUS.FAILED);
    const handoff = row.outputs?.find((o) => o['type'] === 'handoff');
    expect(handoff).toBeTruthy();
    expect((handoff?.['payload'] as Record<string, unknown>)['fromStatus']).toBe('failed');
    // 缺省摘要兜底
    expect(String((handoff?.['payload'] as Record<string, unknown>)['summary'])).toContain(
      '转人工接管',
    );
  });
});

describe('P1-X-33 失败批量处理', () => {
  it('批量重试：failed → 新任务（retry_of 溯源），逐条回传结果', async () => {
    const failedA = createId('task');
    const failedB = createId('task');
    for (const id of [failedA, failedB]) {
      await superDb.insert(schema.aiTask).values({
        id,
        orgId,
        employeeId: empId,
        type: 'lead_hunting',
        title: `X-33 批量重试·${id}`,
        status: TASK_STATUS.FAILED,
        error: 'fixture 失败',
        finishedAt: new Date(),
        input: { goal: '批量重试输入' },
      });
    }

    const resp = await tasksService.batch(orgId, adminId, {
      action: 'retry',
      taskIds: [failedA, failedB],
    });
    expect(resp.total).toBe(2);
    expect(resp.succeeded).toBe(2);
    expect(resp.failed).toBe(0);
    for (const r of resp.results) {
      expect(r.ok).toBe(true);
      expect(r.newTaskId).toBeTruthy();
      const [row] = await superDb
        .select({ retryOf: schema.aiTask.retryOf })
        .from(schema.aiTask)
        .where(eq(schema.aiTask.id, r.newTaskId!))
        .limit(1);
      expect(row?.retryOf).toBe(r.taskId);
      // 清理新建任务可能产生的活跃 job
      await probeEnqueuer
        .removeTask(r.newTaskId!, 'lead_hunting' as TaskType)
        .catch(() => undefined);
    }
  });

  it('批量转人工：非 failed 条目逐条失败不阻断（ok=false 回传原因）', async () => {
    const failedId = createId('task');
    const completedId = createId('task');
    await superDb.insert(schema.aiTask).values({
      id: failedId,
      orgId,
      employeeId: empId,
      type: 'lead_hunting',
      title: 'X-33 批量转人工·failed',
      status: TASK_STATUS.FAILED,
      finishedAt: new Date(),
      input: {},
    });
    await superDb.insert(schema.aiTask).values({
      id: completedId,
      orgId,
      employeeId: empId,
      type: 'lead_hunting',
      title: 'X-33 批量转人工·completed',
      status: TASK_STATUS.COMPLETED,
      finishedAt: new Date(),
      input: {},
    });

    const resp = await tasksService.batch(orgId, adminId, {
      action: 'transfer_to_human',
      taskIds: [failedId, completedId],
      reason: '批量人工接管',
    });
    expect(resp.succeeded).toBe(1);
    expect(resp.failed).toBe(1);
    const okResult = resp.results.find((r) => r.taskId === failedId);
    expect(okResult?.ok).toBe(true);
    const badResult = resp.results.find((r) => r.taskId === completedId);
    expect(badResult?.ok).toBe(false);
    expect(badResult?.error).toContain('仅执行中/已暂停/失败任务可转人工');

    const row = await readTask(failedId);
    expect(row.outputs?.some((o) => o['type'] === 'handoff')).toBe(true);
  });
});
