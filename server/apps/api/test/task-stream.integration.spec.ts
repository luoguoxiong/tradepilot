import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { Redis } from 'ioredis';
import { createId } from '@tradepilot/core';
import { closeDb, createDb, schema, type Db } from '@tradepilot/db';
import { taskEventChannel } from '@tradepilot/shared';
import { TaskStreamController } from '../src/tasks/task-stream.controller.js';

/**
 * SSE API 层测试（后端技术方案 04 §6 / M4 启动清单 A2，M3-T4 测试缺口）：
 * - 任务不存在 → 40401；
 * - 已终态任务开流 → 回放 logs + status + done 补发并关闭（M3-03，杜绝客户端挂等心跳）；
 * - logId 去重（M3-09）：回放与实时 PUBLISH 双通道同 logId 仅投递一次；
 * - 实时 done → 终态投递，req close → 清理收尾；
 * - commit→PUBLISH 崩溃兜底（M3-11）：DB 已终态但 done 丢失 → 5s 兜底轮询补发 status+done 并关闭；
 * - 连接上限（04 §6.1）：单用户 > 10 → 42901；断开后计数回收可重连。
 * 前置：docker compose up（PG 5432 / Redis 6380）+ 迁移已执行。
 */

process.env.REDIS_URL ||= 'redis://localhost:6380';
process.env.DATABASE_URL ||= 'postgresql://tradepilot_app:changeme_app@localhost:5432/tradepilot';

const SUPER_URL = 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';
const APP_URL = 'postgresql://tradepilot_app:changeme_app@localhost:5432/tradepilot';

let superDb: Db;
let appDb: Db;
let redis: Redis;
let controller: TaskStreamController;

const ORG = createId('org');
const EMP = createId('aie');
const TASK_DONE = createId('task');
const TASK_RUNNING = createId('task');
const TASK_POLL = createId('task');
const TASK_LIMIT = createId('task');
const LOG_1 = createId('tlog');
const LOG_2 = createId('tlog');
const LOG_DEDUP = createId('tlog');

// ===== fake req/res（绕过 Nest HTTP 层，直测控制器流控逻辑；authUser 预绑定）=====

interface FakeSse {
  req: Request;
  res: Response;
  events: () => { event: string; data: Record<string, unknown> }[];
  close: () => void;
  ended: () => boolean;
}

function fakeSse(userId: string): FakeSse {
  const chunks: string[] = [];
  let ended = false;
  const closeHandlers: (() => void)[] = [];
  const res = {
    status: () => res,
    setHeader: () => res,
    flushHeaders: () => undefined,
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    end: () => {
      ended = true;
    },
  } as unknown as Response;
  const req = {
    on: (ev: string, cb: () => void) => {
      if (ev === 'close') {
        closeHandlers.push(cb);
      }
      return req;
    },
    // 控制器仅消费 sub/orgId（AccessTokenPayload 最小形状）
    authUser: { sub: userId, orgId: ORG, role: 'admin' },
  } as unknown as Request;
  const parse = () => {
    const out: { event: string; data: Record<string, unknown> }[] = [];
    for (const chunk of chunks) {
      const m = /event: (.+)\ndata: (.+)\n\n/.exec(chunk);
      if (m) {
        out.push({ event: m[1]!, data: JSON.parse(m[2]!) as Record<string, unknown> });
      }
    }
    return out;
  };
  return {
    req,
    res,
    events: parse,
    close: () => closeHandlers.forEach((cb) => cb()),
    ended: () => ended,
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 9_000,
  intervalMs = 200,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

async function publish(taskId: string, payload: Record<string, unknown>): Promise<void> {
  await redis.publish(taskEventChannel(taskId), JSON.stringify(payload));
}

beforeAll(async () => {
  superDb = createDb(SUPER_URL, { max: 2 });
  appDb = createDb(APP_URL, { max: 5 });
  redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 2 });
  controller = new TaskStreamController(appDb, redis);

  await superDb.transaction(async (tx) => {
    await tx.insert(schema.org).values({
      id: ORG,
      name: 'M4-A2 SSE 流测试租户',
      timezone: 'Asia/Shanghai',
    });
    await tx.insert(schema.userAccount).values({
      id: createId('usr'),
      orgId: ORG,
      email: `it-sse-${ORG}@test.com`,
      passwordHash: 'x',
      name: 'SSE 测试管理员',
      role: 'admin',
      status: 'active',
    });
    await tx.insert(schema.aiEmployee).values({
      id: EMP,
      orgId: ORG,
      role: 'sales' as const,
      name: 'SSE 测试员工',
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
    await tx.insert(schema.aiTask).values([
      {
        id: TASK_DONE,
        orgId: ORG,
        employeeId: EMP,
        type: 'lead_hunting',
        title: 'A2 已终态任务',
        status: 'completed',
        outputs: [{ summary: 'A2 终态输出' }],
      },
      {
        id: TASK_RUNNING,
        orgId: ORG,
        employeeId: EMP,
        type: 'lead_hunting',
        title: 'A2 运行中任务',
        status: 'running',
        startedAt: new Date(),
      },
      {
        id: TASK_POLL,
        orgId: ORG,
        employeeId: EMP,
        type: 'lead_hunting',
        title: 'A2 兜底轮询任务',
        status: 'running',
        startedAt: new Date(),
      },
      {
        id: TASK_LIMIT,
        orgId: ORG,
        employeeId: EMP,
        type: 'lead_hunting',
        title: 'A2 连接上限任务',
        status: 'running',
        startedAt: new Date(),
      },
    ]);
    await tx.insert(schema.aiTaskLog).values([
      {
        id: LOG_1,
        orgId: ORG,
        taskId: TASK_DONE,
        occurredAt: new Date(),
        type: 'search',
        content: 'A2 回放日志一',
      },
      {
        id: LOG_2,
        orgId: ORG,
        taskId: TASK_DONE,
        occurredAt: new Date(),
        type: 'found',
        content: 'A2 回放日志二',
      },
      {
        id: LOG_DEDUP,
        orgId: ORG,
        taskId: TASK_RUNNING,
        occurredAt: new Date(),
        type: 'search',
        content: 'A2 去重日志',
      },
    ]);
  });
}, 30_000);

afterAll(async () => {
  await superDb.transaction(async (tx) => {
    const orgIds = [ORG];
    await tx.delete(schema.aiTaskLog).where(inArray(schema.aiTaskLog.orgId, orgIds));
    await tx.delete(schema.aiTask).where(inArray(schema.aiTask.orgId, orgIds));
    await tx.delete(schema.aiEmployee).where(inArray(schema.aiEmployee.orgId, orgIds));
    await tx
      .delete(schema.userAccount)
      .where(and(eq(schema.userAccount.orgId, ORG), sql`true`));
    await tx.delete(schema.org).where(inArray(schema.org.id, orgIds));
  });
  await redis.quit();
  await closeDb(appDb);
  await closeDb(superDb);
});

describe('SSE /tasks/:id/stream（04 §6）', () => {
  it('任务不存在 → 40401', async () => {
    const sse = fakeSse(createId('usr'));
    await expect(
      controller.stream('no-such-task', { limit: 200 }, sse.req, sse.res),
    ).rejects.toMatchObject({ code: 40401 });
  });

  it('已终态任务开流：回放 logs + status + done 补发并关闭（M3-03）', async () => {
    const sse = fakeSse(createId('usr'));
    await controller.stream(TASK_DONE, { limit: 200 }, sse.req, sse.res);
    const events = sse.events();
    const logIds = events
      .filter((e) => e.event === 'log')
      .map((e) => (e.data.payload as { logId: string }).logId);
    expect(logIds).toEqual([LOG_1, LOG_2]);
    expect(events.some((e) => e.event === 'status' && e.data.status === 'completed')).toBe(true);
    expect(
      events.some(
        (e) =>
          e.event === 'done' &&
          e.data.status === 'completed' &&
          JSON.stringify(e.data.outputs ?? '').includes('A2 终态输出'),
      ),
    ).toBe(true);
    expect(sse.ended()).toBe(true);
  });

  it('logId 去重（M3-09）：回放已投递的 logId 再经实时通道重复 PUBLISH → 仅一条 log 事件', async () => {
    const sse = fakeSse(createId('usr'));
    await controller.stream(TASK_RUNNING, { limit: 200 }, sse.req, sse.res);
    // 回放已发送 LOG_DEDUP；再重复 PUBLISH 同一 logId 两次（模拟订阅→回放交错双收）
    const msg = {
      type: 'log',
      seq: '01J',
      payload: { logId: LOG_DEDUP, type: 'search', content: 'A2 去重日志' },
    };
    await publish(TASK_RUNNING, msg);
    await publish(TASK_RUNNING, msg);
    await new Promise((r) => setTimeout(r, 300));

    const logEvents = sse.events().filter((e) => e.event === 'log');
    expect(logEvents).toHaveLength(1);

    // 实时 done → 投递终态
    await publish(TASK_RUNNING, {
      type: 'done',
      seq: '02J',
      payload: { status: 'completed', outputs: [] },
    });
    expect(await waitFor(() => sse.events().some((e) => e.event === 'done'))).toBe(true);
    sse.close();
    expect(sse.ended()).toBe(true);
  });

  it('M3-11 兜底轮询：DB 已终态但 done 未发布 → 5s 内按 DB 最新态补发 status+done 并关闭', async () => {
    const sse = fakeSse(createId('usr'));
    await controller.stream(TASK_POLL, { limit: 200 }, sse.req, sse.res);
    expect(sse.events().some((e) => e.event === 'done')).toBe(false);

    // Worker commit 后 PUBLISH 前崩溃的等效态：只改 DB，不发 done 事件
    await superDb
      .update(schema.aiTask)
      .set({ status: 'failed', error: 'poll_fixture', finishedAt: new Date() })
      .where(eq(schema.aiTask.id, TASK_POLL));

    const ok = await waitFor(() => sse.events().some((e) => e.event === 'done'));
    expect(ok).toBe(true);
    const done = sse.events().find((e) => e.event === 'done');
    expect(done?.data).toMatchObject({ status: 'failed', error: 'poll_fixture' });
    expect(sse.ended()).toBe(true);
  }, 15_000);

  it('连接上限（04 §6.1）：单用户 10 条 → 第 11 条 42901；全部断开后计数回收', async () => {
    const userId = createId('usr');
    const streams: FakeSse[] = [];
    for (let i = 0; i < 10; i += 1) {
      const sse = fakeSse(userId);
      await controller.stream(TASK_LIMIT, { limit: 200 }, sse.req, sse.res);
      streams.push(sse);
    }
    const eleventh = fakeSse(userId);
    await expect(
      controller.stream(TASK_LIMIT, { limit: 200 }, eleventh.req, eleventh.res),
    ).rejects.toMatchObject({ code: 42901 });

    // 断开全部 → 计数回收，可再次建立连接
    for (const sse of streams) {
      sse.close();
      expect(sse.ended()).toBe(true);
    }
    const again = fakeSse(userId);
    await controller.stream(TASK_LIMIT, { limit: 200 }, again.req, again.res);
    again.close();
    expect(again.ended()).toBe(true);
  }, 20_000);
});
