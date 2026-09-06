/**
 * Dispatcher 并发闸门（后端技术方案 04 §3.3）：
 * 扫 ai_task.status='scheduled'（sched_scan 跨租户 SELECT）→ FIFO 逐个预检：
 *   - 单员工并发 = 1（该员工 running 任务数 = 0 才启动）；
 *   - org 总并发 = 10（running 计数 < 10；waiting_approval 不占并发，仅统计 running）。
 * 通过 → TaskEnqueuer 投递（jobId=taskId 防重复）；未通过 → 保持 scheduled 不动。
 * 置 running 的乐观锁由 TaskRunner.claim 唯一执行（Dispatcher 只预检，不触碰任务行）。
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Db } from '@tradepilot/db';
import type { TaskEnqueuer } from '@tradepilot/runtime';
import type { Logger } from 'pino';

/** 扫描周期（04 §3.1：每 2s） */
export const DISPATCH_INTERVAL_MS = 2_000;
/** org 总并发 MVP 内置常量（04 §3.3） */
export const ORG_CONCURRENCY_LIMIT = 10;
/** 单轮扫描上限 */
const BATCH_SIZE = 50;

export interface DispatcherDeps {
  db: Db;
  enqueuer: TaskEnqueuer;
  logger: Logger;
}

interface QueuedTask {
  id: string;
  orgId: string;
  employeeId: string;
  type: string;
}

export class Dispatcher {
  constructor(private readonly deps: DispatcherDeps) {}

  /** 单轮扫描：返回本轮投递数（测试可直接调用） */
  async tick(now = new Date()): Promise<number> {
    const { db, enqueuer, logger } = this.deps;

    // ① 跨租户扫描排队队首（FIFO = coalesce(scheduled_at, created_at)；未到点的定时任务不投）
    const queued = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.sched', '1', true)`);
      return tx
        .select({
          id: schema.aiTask.id,
          orgId: schema.aiTask.orgId,
          employeeId: schema.aiTask.employeeId,
          type: schema.aiTask.type,
        })
        .from(schema.aiTask)
        .where(
          and(
            eq(schema.aiTask.status, 'scheduled'),
            sql`(${schema.aiTask.scheduledAt} is null or ${schema.aiTask.scheduledAt} <= ${now.toISOString()})`,
          ),
        )
        .orderBy(sql`coalesce(${schema.aiTask.scheduledAt}, ${schema.aiTask.createdAt})`)
        .limit(BATCH_SIZE);
    }) as QueuedTask[];
    if (queued.length === 0) {
      return 0;
    }

    // ② 闸门计数（sched 上下文聚合；waiting_approval 不占并发）
    const orgIds = [...new Set(queued.map((t) => t.orgId))];
    const employeeIds = [...new Set(queued.map((t) => t.employeeId))];
    const [orgRunning, empRunning] = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.sched', '1', true)`);
      const orgRows = await tx
        .select({ orgId: schema.aiTask.orgId, n: sql<number>`count(*)::int` })
        .from(schema.aiTask)
        .where(and(inArray(schema.aiTask.orgId, orgIds), eq(schema.aiTask.status, 'running')))
        .groupBy(schema.aiTask.orgId);
      const empRows = await tx
        .select({ employeeId: schema.aiTask.employeeId, n: sql<number>`count(*)::int` })
        .from(schema.aiTask)
        .where(and(inArray(schema.aiTask.employeeId, employeeIds), eq(schema.aiTask.status, 'running')))
        .groupBy(schema.aiTask.employeeId);
      return [
        new Map(orgRows.map((r) => [r.orgId, r.n])),
        new Map(empRows.map((r) => [r.employeeId, r.n])),
      ] as const;
    });

    // ③ FIFO 投递；本轮内累加额度防超发；未通过保持 scheduled（下轮再试）
    let dispatched = 0;
    for (const task of queued) {
      const empUsed = empRunning.get(task.employeeId) ?? 0;
      const orgUsed = orgRunning.get(task.orgId) ?? 0;
      if (empUsed >= 1) {
        logger.debug({ taskId: task.id, employeeId: task.employeeId }, '员工并发=1 占用，保持 scheduled');
        continue;
      }
      if (orgUsed >= ORG_CONCURRENCY_LIMIT) {
        logger.debug({ taskId: task.id, orgId: task.orgId, orgUsed }, 'org 并发已满，保持 scheduled');
        continue;
      }
      await enqueuer.enqueueTask(task.id, task.type as never);
      dispatched += 1;
      empRunning.set(task.employeeId, empUsed + 1);
      orgRunning.set(task.orgId, orgUsed + 1);
    }
    if (dispatched > 0) {
      logger.info({ dispatched, scanned: queued.length }, 'Dispatcher 本轮投递');
    }
    return dispatched;
  }
}
