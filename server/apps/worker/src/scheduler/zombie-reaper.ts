/**
 * ZombieReaper 僵尸任务收割（后端技术方案 04 §5.4）：
 * 每 60s 扫 ai_task（running AND started_at 超 30min，sched_scan SELECT）→ Redis 心跳缺失
 * （worker 每 30s 心跳 / 90s TTL）→ 置 failed('timeout')（可手动重试）+ 员工回 idle + SSE done。
 */
import { and, eq, sql } from 'drizzle-orm';
import { schema, withOrg, type Db } from '@tradepilot/db';
import {
  buildDoneEvent,
  buildStatusEvent,
  heartbeatKey,
  releaseEmployeeIdle,
  type TaskEventPublisher,
} from '@tradepilot/runtime';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

/** 扫描周期（04 §3.1：每 60s） */
export const ZOMBIE_SCAN_INTERVAL_MS = 60_000;
/** started_at 超时阈值（04 §5.4：30min；心跳 30s/TTL 90s，取宽裕值防误杀长节点） */
export const ZOMBIE_STALE_MS = 30 * 60_000;
const BATCH_SIZE = 50;

export interface ZombieReaperDeps {
  db: Db;
  redis: Redis;
  publisher: TaskEventPublisher;
  logger: Logger;
}

export class ZombieReaper {
  constructor(private readonly deps: ZombieReaperDeps) {}

  /** 单轮扫描：返回收割数（测试可直接调用） */
  async tick(now = new Date()): Promise<number> {
    const { db, redis } = this.deps;

    const stale = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.sched', '1', true)`);
      return tx
        .select({
          id: schema.aiTask.id,
          orgId: schema.aiTask.orgId,
          employeeId: schema.aiTask.employeeId,
          startedAt: schema.aiTask.startedAt,
        })
        .from(schema.aiTask)
        .where(
          and(
            eq(schema.aiTask.status, 'running'),
            sql`${schema.aiTask.startedAt} is not null and ${schema.aiTask.startedAt} < ${new Date(now.getTime() - ZOMBIE_STALE_MS).toISOString()}`,
          ),
        )
        .limit(BATCH_SIZE);
    });

    let reaped = 0;
    for (const task of stale) {
      // 心跳仍存在 = 图仍在跑（长节点），不收割
      const alive = await redis.exists(heartbeatKey(task.id));
      if (alive) {
        continue;
      }
      const ok = await this.reap(task, now);
      if (ok) {
        reaped += 1;
      }
    }
    return reaped;
  }

  /** 收割：failed('timeout')（乐观锁 running → failed，防与正常终态竞争） */
  private async reap(
    task: { id: string; orgId: string; employeeId: string; startedAt: Date | null },
    now: Date,
  ): Promise<boolean> {
    const { db, redis, publisher, logger } = this.deps;
    const done = await withOrg(db, task.orgId, async (tx) => {
      const updated = await tx
        .update(schema.aiTask)
        .set({ status: 'failed', error: 'timeout', finishedAt: now, updatedAt: now })
        .where(and(eq(schema.aiTask.id, task.id), eq(schema.aiTask.status, 'running')))
        .returning({ id: schema.aiTask.id });
      if (updated.length === 0) {
        return false;
      }
      // M3-06：终态回写前置校验——员工仍占用其它任务则保持状态
      const released = await releaseEmployeeIdle(tx, {
        employeeId: task.employeeId,
        excludeTaskId: task.id,
        now,
      });
      if (!released) {
        logger.warn(
          { taskId: task.id, employeeId: task.employeeId },
          '僵尸收割置 failed 但员工仍占用其它任务，保持员工状态（终态回写前置校验）',
        );
      }
      return true;
    });
    if (!done) {
      return false;
    }
    await redis.del(heartbeatKey(task.id));
    await publisher.publish(task.id, buildStatusEvent({ status: 'failed', error: 'timeout' }));
    await publisher.publish(
      task.id,
      buildDoneEvent({ status: 'failed', outputs: [], error: 'timeout' }),
    );
    logger.warn(
      { taskId: task.id, startedAt: task.startedAt?.toISOString() },
      '僵尸任务已收割（心跳缺失，timeout）',
    );
    return true;
  }
}
