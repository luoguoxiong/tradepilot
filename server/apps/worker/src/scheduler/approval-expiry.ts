/**
 * ApprovalExpiryScanner 审批超时扫描（后端技术方案 04 §4 / Runtime §4.7）：
 * 每 60s 扫 approval_request（pending AND expires_at < now，sched_scan SELECT）→ 逐条 withOrg 单事务：
 *   approval_request.status='expired'（终态）+ approval_log(action='expired'，系统代理留痕，防重）
 *   + 级联 ai_task.failed(approval_expired) + follow_up_task.paused（转人工）
 *   + q:notify 邮件提醒经理一次（log 已有 expired 留痕则不再发）+ SSE status/done 事件。
 */
import { and, eq, sql } from 'drizzle-orm';
import { createId } from '@tradepilot/core';
import { schema, withOrg, type Db } from '@tradepilot/db';
import { buildDoneEvent, buildStatusEvent, type TaskEventPublisher } from '@tradepilot/runtime';
import type { TaskEnqueuer } from '@tradepilot/runtime';
import type { Logger } from 'pino';

/** 扫描周期（04 §3.1：每 60s） */
export const APPROVAL_EXPIRY_INTERVAL_MS = 60_000;
const BATCH_SIZE = 50;

export interface ApprovalExpiryScannerDeps {
  db: Db;
  publisher: TaskEventPublisher;
  enqueuer: TaskEnqueuer;
  logger: Logger;
}

export class ApprovalExpiryScanner {
  constructor(private readonly deps: ApprovalExpiryScannerDeps) {}

  /** 单轮扫描：返回过期处置数（测试可直接调用） */
  async tick(now = new Date()): Promise<number> {
    const { db } = this.deps;

    // ① 跨租户扫描 pending 且已过期
    const expired = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.sched', '1', true)`);
      return tx
        .select({
          id: schema.approvalRequest.id,
          orgId: schema.approvalRequest.orgId,
          linkedTaskId: schema.approvalRequest.linkedTaskId,
          title: schema.approvalRequest.title,
        })
        .from(schema.approvalRequest)
        .where(
          and(eq(schema.approvalRequest.status, 'pending'), sql`${schema.approvalRequest.expiresAt} < ${now.toISOString()}`),
        )
        .limit(BATCH_SIZE);
    });
    let handled = 0;
    for (const req of expired) {
      try {
        const ok = await this.expire(req, now);
        if (ok) {
          handled += 1;
        }
      } catch (err) {
        this.deps.logger.warn(
          { approvalId: req.id, err: err instanceof Error ? err.message : String(err) },
          '审批过期处置失败，下轮重试',
        );
      }
    }
    return handled;
  }

  /** 单条过期处置（乐观锁 expired 终态；返回 false = 已被并发处置） */
  private async expire(
    req: { id: string; orgId: string; linkedTaskId: string | null; title: string },
    now: Date,
  ): Promise<boolean> {
    const { db, publisher, enqueuer, logger } = this.deps;
    return withOrg(db, req.orgId, async (tx) => {
      // 防重：已有 expired 留痕 → 本轮跳过（含不再发通知）
      const [logExists] = await tx
        .select({ id: schema.approvalLog.id })
        .from(schema.approvalLog)
        .where(and(eq(schema.approvalLog.approvalId, req.id), eq(schema.approvalLog.action, 'expired')))
        .limit(1);
      if (logExists) {
        return false;
      }

      // expired 终态（乐观锁）
      const updated = await tx
        .update(schema.approvalRequest)
        .set({ status: 'expired', updatedAt: now })
        .where(and(eq(schema.approvalRequest.id, req.id), eq(schema.approvalRequest.status, 'pending')))
        .returning({ id: schema.approvalRequest.id });
      if (updated.length === 0) {
        return false;
      }

      // 留痕（approver_id 非空约束 → 系统 = org 首个 manager/admin 用户代理）
      const [proxy] = await tx
        .select({ id: schema.userAccount.id, name: schema.userAccount.name })
        .from(schema.userAccount)
        .where(and(eq(schema.userAccount.orgId, req.orgId), sql`${schema.userAccount.role} in ('manager','admin')`))
        .orderBy(schema.userAccount.createdAt)
        .limit(1);
      await tx.insert(schema.approvalLog).values({
        id: createId('alog'),
        orgId: req.orgId,
        approvalId: req.id,
        action: 'expired',
        approverId: proxy?.id ?? '',
        approverName: proxy ? `${proxy.name}（系统超时代理）` : '系统（超时）',
        decidedAt: now,
      });

      // 级联 ai_task.failed(approval_expired)（乐观锁 waiting_approval → failed）
      let failedTaskId: string | null = null;
      if (req.linkedTaskId) {
        const [before] = await tx
          .select({ input: schema.aiTask.input })
          .from(schema.aiTask)
          .where(eq(schema.aiTask.id, req.linkedTaskId))
          .limit(1);
        const [taskRow] = await tx
          .update(schema.aiTask)
          .set({ status: 'failed', error: 'approval_expired', finishedAt: now, updatedAt: now })
          .where(and(eq(schema.aiTask.id, req.linkedTaskId), eq(schema.aiTask.status, 'waiting_approval')))
          .returning({ id: schema.aiTask.id, employeeId: schema.aiTask.employeeId });
        if (taskRow) {
          failedTaskId = taskRow.id;
          await tx
            .update(schema.aiEmployee)
            .set({ status: 'idle', statusDetail: null, updatedAt: now })
            .where(eq(schema.aiEmployee.id, taskRow.employeeId));
          // 级联 follow_up_task.paused（转人工；挂起时已同步 waiting_approval）
          const followUpTaskId = typeof before?.input?.['followUpTaskId'] === 'string' ? before.input['followUpTaskId'] : null;
          if (followUpTaskId) {
            await tx
              .update(schema.followUpTask)
              .set({ status: 'paused', updatedAt: now })
              .where(
                and(
                  eq(schema.followUpTask.id, followUpTaskId),
                  eq(schema.followUpTask.status, 'waiting_approval'),
                ),
              );
          }
        }
      }

      // 邮件提醒经理一次（q:notify；通知服务随 M5 实装，此处仅投递）
      await enqueuer.enqueueNotify({ type: 'approval_expired', approvalId: req.id, orgId: req.orgId, title: req.title });

      // SSE：任务侧 failed + done
      if (failedTaskId) {
        await publisher.publish(failedTaskId, buildStatusEvent({ status: 'failed', error: 'approval_expired' }));
        await publisher.publish(failedTaskId, buildDoneEvent({ status: 'failed', outputs: [], error: 'approval_expired' }));
      }
      logger.info({ approvalId: req.id, taskId: failedTaskId }, '审批超时：expired 终态并级联转人工');
      return true;
    });
  }
}
