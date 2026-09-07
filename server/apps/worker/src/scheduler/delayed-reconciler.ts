/**
 * DelayedJobReconciler delayed job 对账（后端技术方案 04 §3.1/§3.4）：
 * 每 60s 对账「ai_task.scheduled_at 到期但 status='scheduled' 且 BullMQ 无对应活跃 job」
 * （Redis 丢失兜底）→ 补投。jobId=taskId 天然幂等。
 * 补投前执行与 Dispatcher 一致的员工/org 并发闸门（04 §3.3；M3-06）：
 * 员工占用（running/waiting_approval）或 org running≥10 的任务保持 scheduled，由 Dispatcher 稍后投递，
 * 避免补投绕过闸门造成「员工双 running / org 超发」。
 */
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { schema, type Db } from '@tradepilot/db';
import type { TaskEnqueuer } from '@tradepilot/runtime';
import { EMPLOYEE_OCCUPYING_TASK_STATUSES, type TaskType } from '@tradepilot/shared';
import type { Logger } from 'pino';
import { ORG_CONCURRENCY_LIMIT } from './dispatcher.js';

/** 扫描周期（04 §3.1：每 60s） */
export const RECONCILE_INTERVAL_MS = 60_000;
const BATCH_SIZE = 50;

export interface DelayedReconcilerDeps {
  db: Db;
  enqueuer: TaskEnqueuer;
  logger: Logger;
}

export class DelayedJobReconciler {
  constructor(private readonly deps: DelayedReconcilerDeps) {}

  /** 单轮对账：返回补投数（测试可直接调用） */
  async tick(now = new Date()): Promise<number> {
    const { db, enqueuer } = this.deps;

    // 到期但仍在排队的任务（sched 上下文跨租户 SELECT）
    const due = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.sched', '1', true)`);
      return tx
        .select({
          id: schema.aiTask.id,
          type: schema.aiTask.type,
          orgId: schema.aiTask.orgId,
          employeeId: schema.aiTask.employeeId,
        })
        .from(schema.aiTask)
        .where(
          and(
            eq(schema.aiTask.status, 'scheduled'),
            // lte 对 null 恒 false，天然排除 scheduled_at 为空的立即任务
            lte(schema.aiTask.scheduledAt, now),
          ),
        )
        .limit(BATCH_SIZE);
    });
    if (due.length === 0) {
      return 0;
    }

    // 员工/org 并发闸门计数（与 Dispatcher 同口径：员工占用含 waiting_approval，org 仅统计 running）
    const employeeIds = [...new Set(due.map((t) => t.employeeId))];
    const orgIds = [...new Set(due.map((t) => t.orgId))];
    const [empBusy, orgRunning] = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.sched', '1', true)`);
      const empRows = await tx
        .select({ employeeId: schema.aiTask.employeeId, n: sql<number>`count(*)::int` })
        .from(schema.aiTask)
        .where(
          and(
            inArray(schema.aiTask.employeeId, employeeIds),
            inArray(schema.aiTask.status, [...EMPLOYEE_OCCUPYING_TASK_STATUSES]),
          ),
        )
        .groupBy(schema.aiTask.employeeId);
      const orgRows = await tx
        .select({ orgId: schema.aiTask.orgId, n: sql<number>`count(*)::int` })
        .from(schema.aiTask)
        .where(and(inArray(schema.aiTask.orgId, orgIds), eq(schema.aiTask.status, 'running')))
        .groupBy(schema.aiTask.orgId);
      return [
        new Map(empRows.map((r) => [r.employeeId, r.n])),
        new Map(orgRows.map((r) => [r.orgId, r.n])),
      ] as const;
    });

    let requeued = 0;
    for (const task of due) {
      const hasJob = await enqueuer.hasActiveJob(task.id, task.type as TaskType);
      if (hasJob) {
        continue;
      }
      // 闸门未通过 → 保持 scheduled（员工空闲 / org 腾位后由 Dispatcher 每 2s 投递）
      const empUsed = empBusy.get(task.employeeId) ?? 0;
      const orgUsed = orgRunning.get(task.orgId) ?? 0;
      if (empUsed >= 1) {
        continue;
      }
      if (orgUsed >= ORG_CONCURRENCY_LIMIT) {
        continue;
      }
      await enqueuer.enqueueTask(task.id, task.type as TaskType);
      requeued += 1;
      empBusy.set(task.employeeId, empUsed + 1);
      orgRunning.set(task.orgId, orgUsed + 1);
      this.deps.logger.warn({ taskId: task.id }, 'delayed job 丢失，已补投（Reconciler 对账）');
    }
    return requeued;
  }
}
