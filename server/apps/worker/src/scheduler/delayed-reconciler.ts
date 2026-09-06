/**
 * DelayedJobReconciler delayed job 对账（后端技术方案 04 §3.1/§3.4）：
 * 每 60s 对账「ai_task.scheduled_at 到期但 status='scheduled' 且 BullMQ 无对应活跃 job」
 * （Redis 丢失兜底）→ 补投。jobId=taskId 天然幂等；闸门由 Dispatcher 预检 + runner.claim 乐观锁兜底。
 */
import { and, eq, lte, sql } from 'drizzle-orm';
import { schema, type Db } from '@tradepilot/db';
import type { TaskEnqueuer } from '@tradepilot/runtime';
import type { Logger } from 'pino';
import type { TaskType } from '@tradepilot/shared';

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
        .select({ id: schema.aiTask.id, type: schema.aiTask.type })
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

    let requeued = 0;
    for (const task of due) {
      const hasJob = await enqueuer.hasActiveJob(task.id, task.type as TaskType);
      if (hasJob) {
        continue;
      }
      await enqueuer.enqueueTask(task.id, task.type as TaskType);
      requeued += 1;
      this.deps.logger.warn({ taskId: task.id }, 'delayed job 丢失，已补投（Reconciler 对账）');
    }
    return requeued;
  }
}
