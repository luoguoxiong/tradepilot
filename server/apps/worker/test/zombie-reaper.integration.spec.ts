import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pino from 'pino';
import type { Logger } from 'pino';
import type { TaskEventPublisher } from '@tradepilot/runtime';
import { heartbeatKey } from '@tradepilot/runtime';
import { createId } from '@tradepilot/core';
import { closeDb, createDb, schema, type Db } from '@tradepilot/db';
import { ZombieReaper } from '../src/scheduler/zombie-reaper.js';

/**
 * ZombieReaper 独立 spec（后端技术方案 04 §5.4 / M4 启动清单 A3，M3-T2 测试缺口）：
 * - running 且 started_at 超阈（30min）+ Redis 心跳缺失 → failed('timeout') + 员工回 idle
 *   + 心跳 key 清理 + SSE status/done；
 * - 心跳仍存活（长节点）→ 不收割；
 * - started_at 新鲜 → 不进入扫描；
 * - 员工终态回写前置校验（M3-06）：员工仍占用其它任务 → 保持状态。
 * 前置：docker compose up（PG 5432 / Redis 6380）；扫描经 superDb（BYPASSRLS）。
 */

const SUPER_URL =
  process.env.TEST_DB_URL ?? 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';
const logger: Logger = pino({ level: 'silent' });

let db: Db;
let redis: Redis;

const ORG = createId('org');
const USER = createId('usr');
const EMP = createId('aie');
const EMP_BUSY = createId('aie');
const TASK_STALE = createId('task');
const TASK_ALIVE = createId('task');
const TASK_FRESH = createId('task');
const TASK_BUSY = createId('task');

const publisher = { publish: vi.fn(async () => undefined) } as unknown as TaskEventPublisher;

let reaper: ZombieReaper;

async function insertRunningTask(values: {
  id: string;
  employeeId: string;
  startedAt: Date | null;
  title: string;
}): Promise<void> {
  await db.insert(schema.aiTask).values({
    id: values.id,
    orgId: ORG,
    employeeId: values.employeeId,
    type: 'lead_hunting',
    title: values.title,
    status: 'running',
    ...(values.startedAt ? { startedAt: values.startedAt } : {}),
  });
}

beforeAll(async () => {
  db = createDb(SUPER_URL, { max: 5 });
  redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6380', { maxRetriesPerRequest: 2 });
  reaper = new ZombieReaper({ db, redis, publisher, logger });

  // 跨租户扫描器对 DB 残留敏感：全局清表保干净基线
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`TRUNCATE TABLE ai_task, ai_task_log, ai_task_step RESTART IDENTITY CASCADE`,
    );
  });

  await db.transaction(async (tx) => {
    await tx.insert(schema.org).values({
      id: ORG,
      name: 'M4-A3 僵尸收割租户',
      timezone: 'Asia/Shanghai',
    });
    await tx.insert(schema.userAccount).values({
      id: USER,
      orgId: ORG,
      email: `it-zombie-${ORG}@test.com`,
      passwordHash: 'x',
      name: '收割测试管理员',
      role: 'admin',
      status: 'active',
    });
    await tx.insert(schema.aiEmployee).values([
      {
        id: EMP,
        orgId: ORG,
        role: 'sales' as const,
        name: '失联员工',
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
      },
      {
        id: EMP_BUSY,
        orgId: ORG,
        role: 'sales' as const,
        name: '占用员工',
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
      },
    ]);
  });

  const stale = new Date(Date.now() - 31 * 60_000);
  await insertRunningTask({
    id: TASK_STALE,
    employeeId: EMP,
    startedAt: stale,
    title: 'A3 超时失联任务',
  });
  await insertRunningTask({
    id: TASK_ALIVE,
    employeeId: EMP_BUSY,
    startedAt: stale,
    title: 'A3 心跳存活长任务',
  });
  await insertRunningTask({
    id: TASK_FRESH,
    employeeId: EMP,
    startedAt: new Date(),
    title: 'A3 新鲜运行任务',
  });
  await insertRunningTask({
    id: TASK_BUSY,
    employeeId: EMP_BUSY,
    startedAt: stale,
    title: 'A3 员工占用场景任务',
  });
  // EMP_BUSY 的其它占用任务（M3-06：收割 TASK_BUSY 后员工仍被 TASK_ALIVE 占用）
  await db.insert(schema.aiTask).values({
    id: createId('task'),
    orgId: ORG,
    employeeId: EMP_BUSY,
    type: 'lead_hunting',
    title: 'A3 员工占用中的另一任务',
    status: 'running',
    startedAt: new Date(),
  });

  // 心跳存活场景：TASK_ALIVE 心跳在（90s TTL，04 §5.4 心跳 30s）
  await redis.set(heartbeatKey(TASK_ALIVE), '1', 'EX', 90);
  // 心跳残留 key（模拟崩溃后遗留）→ 收割时清理
  await redis.set(heartbeatKey(TASK_BUSY), '1', 'EX', 90);
});

afterAll(async () => {
  for (const id of [TASK_ALIVE, TASK_BUSY]) {
    await redis.del(heartbeatKey(id)).catch(() => undefined);
  }
  await db.transaction(async (tx) => {
    const orgIds = [ORG];
    await tx.delete(schema.aiTask).where(inArray(schema.aiTask.orgId, orgIds));
    await tx.delete(schema.aiEmployee).where(inArray(schema.aiEmployee.orgId, orgIds));
    await tx.delete(schema.userAccount).where(inArray(schema.userAccount.orgId, orgIds));
    await tx.delete(schema.org).where(inArray(schema.org.id, orgIds));
  });
  await redis.quit();
  await closeDb(db);
});

describe('ZombieReaper（04 §5.4）', () => {
  it('心跳缺失 + started_at 超阈 → failed(timeout) + 员工回 idle + 心跳清理 + SSE done', async () => {
    const reaped = await reaper.tick();
    // 失联：TASK_STALE + TASK_BUSY；TASK_ALIVE 心跳存活、TASK_FRESH 新鲜 → 不收
    expect(reaped).toBe(2);

    const [task] = await db
      .select({
        status: schema.aiTask.status,
        error: schema.aiTask.error,
        finishedAt: schema.aiTask.finishedAt,
      })
      .from(schema.aiTask)
      .where(eq(schema.aiTask.id, TASK_STALE));
    expect(task?.status).toBe('failed');
    expect(task?.error).toBe('timeout');
    expect(task?.finishedAt).not.toBeNull();

    // 员工无其它占用任务 → idle
    const [emp] = await db
      .select({ status: schema.aiEmployee.status })
      .from(schema.aiEmployee)
      .where(eq(schema.aiEmployee.id, EMP));
    expect(emp?.status).toBe('idle');

    // 心跳残留 key 清理
    expect(await redis.exists(heartbeatKey(TASK_BUSY))).toBe(0);

    // SSE：status + done（timeout 语义）
    const events = publisher.publish.mock.calls.filter((c) => c[0] === TASK_STALE);
    expect(events).toHaveLength(2);
    expect(events[0]![1]).toMatchObject({ type: 'status', payload: { status: 'failed', error: 'timeout' } });
    expect(events[1]![1]).toMatchObject({ type: 'done', payload: { status: 'failed' } });
  });

  it('心跳仍存活（长节点）→ 不收割，保持 running', async () => {
    const [task] = await db
      .select({ status: schema.aiTask.status })
      .from(schema.aiTask)
      .where(eq(schema.aiTask.id, TASK_ALIVE));
    expect(task?.status).toBe('running');
    expect(await redis.exists(heartbeatKey(TASK_ALIVE))).toBe(1);
  });

  it('started_at 新鲜 → 不进入扫描', async () => {
    const [task] = await db
      .select({ status: schema.aiTask.status, finishedAt: schema.aiTask.finishedAt })
      .from(schema.aiTask)
      .where(eq(schema.aiTask.id, TASK_FRESH));
    expect(task?.status).toBe('running');
    expect(task?.finishedAt).toBeNull();
  });

  it('员工仍占用其它任务 → 收割置 failed 但不回 idle（M3-06）', async () => {
    const [task] = await db
      .select({ status: schema.aiTask.status })
      .from(schema.aiTask)
      .where(eq(schema.aiTask.id, TASK_BUSY));
    expect(task?.status).toBe('failed');
    const [emp] = await db
      .select({ status: schema.aiEmployee.status })
      .from(schema.aiEmployee)
      .where(eq(schema.aiEmployee.id, EMP_BUSY));
    expect(emp?.status).toBe('working');
  });
});
