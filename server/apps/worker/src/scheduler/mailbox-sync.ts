/**
 * MailboxSyncScheduler 邮箱同步周期触发（后端技术方案 04 §3.1 / 06 §2.2，M4 #4、M3-13 承接）：
 * 每 5min 扫描全部非 disconnected 邮箱（sched_scan 跨租户 SELECT）→ 逐个投递 q:email_sync
 * （jobId=mbxsync:{mailboxId}，同 mailbox 活跃 job 唯一，防长同步 + 周期触发堆积）。
 * 首次同步回填：since = last_synced_at ?? now - syncScope.historyDays（消费侧计算，04 §3.4 delayed 语义不需要）。
 */
import { ne } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { schema, type Db } from '@tradepilot/db';
import type { TaskEnqueuer } from '@tradepilot/runtime';
import type { Logger } from 'pino';

/** 扫描周期（06 §2.2：每 5min） */
export const MAILBOX_SYNC_INTERVAL_MS = 5 * 60_000;
/** 单轮投递上限 */
const BATCH_SIZE = 100;

export interface MailboxSyncSchedulerDeps {
  db: Db;
  enqueuer: TaskEnqueuer;
  logger: Logger;
}

export class MailboxSyncScheduler {
  constructor(private readonly deps: MailboxSyncSchedulerDeps) {}

  /** 单轮扫描：返回本轮投递的邮箱数（测试可直接调用） */
  async tick(): Promise<number> {
    const { db, enqueuer, logger } = this.deps;
    // sched 白名单跨租户扫描（02 §4：sched 角色仅白名单表——mailbox 在白名单内）
    const mailboxes = (await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.sched', '1', true)`);
      return tx
        .select({ id: schema.mailbox.id, orgId: schema.mailbox.orgId })
        .from(schema.mailbox)
        .where(ne(schema.mailbox.status, 'disconnected'))
        .limit(BATCH_SIZE);
    })) as { id: string; orgId: string }[];

    let enqueued = 0;
    for (const mbx of mailboxes) {
      try {
        await enqueuer.enqueueEmailSync(mbx.id);
        enqueued += 1;
      } catch (err) {
        logger.warn(
          {
            mailboxId: mbx.id,
            orgId: mbx.orgId,
            err: err instanceof Error ? err.message : String(err),
          },
          '邮箱同步入队失败',
        );
      }
    }
    if (mailboxes.length > 0) {
      logger.info({ scanned: mailboxes.length, enqueued }, 'MailboxSyncScheduler 本轮扫描');
    }
    return enqueued;
  }
}
