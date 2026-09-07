/**
 * FollowUpScanner 频控预检（后端技术方案 04 §3.1/§3.2 + 07 v0.2.1）：
 * 每 10s 扫 follow_up_task（status ∈ ready/scheduled AND next_run_at <= now，sched_scan 跨租户 SELECT）
 * → 逐任务 withOrg 频控预检（与图内 schedule_next 共用 @tradepilot/core 同一公式）：
 *   - 预检不满足 → next_run_at 顺延写入（单行乐观锁）+ follow_up_execution(skipped, frequency_capped) 留痕，不入队；
 *   - 预检通过 → 建 ai_task(follow_up, status='scheduled') 待 Dispatcher 启动（排期单一写入口：本扫描 + schedule_next）。
 * 防重复（多 worker 实例，04 §3.1，M3-04）：
 *   - 快路径：tick 内活跃 ai_task 批量预筛（step ②，快照，非权威）；
 *   - 权威：preCheck 以 follow_up_task 行锁 FOR UPDATE SKIP LOCKED 串行化领取，
 *     锁内复核活跃 ai_task（scheduled/running/waiting_approval）存在即 busy；
 *   - 兜底：ai_task.input ->> 'followUpTaskId' 部分唯一索引（uq_ai_task_active_followup，
 *     manual 0004），insert onConflictDoNothing，败者按 busy 让出。
 */
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { createId, computeDeferredNextRunAt, type SendWindow } from '@tradepilot/core';
import { schema, withOrg, type Db } from '@tradepilot/db';
import type { Logger } from 'pino';

/** 扫描周期（04 §3.1：每 10s） */
export const FOLLOW_UP_SCAN_INTERVAL_MS = 10_000;
const BATCH_SIZE = 50;

export interface FollowUpScannerDeps {
  db: Db;
  logger: Logger;
}

export interface ScanTickResult {
  scanned: number;
  deferred: number;
  enqueued: number;
}

/** org.send_rules.sendWindow（'HH:MM'）→ core SendWindow（小时粒度） */
function parseSendWindow(sendRules: Record<string, unknown> | null): SendWindow | undefined {
  const window = sendRules?.['sendWindow'] as { start?: string; end?: string } | undefined;
  if (!window?.start || !window?.end) {
    return undefined;
  }
  const startHour = Number.parseInt(window.start.slice(0, 2), 10);
  const endHour = Number.parseInt(window.end.slice(0, 2), 10);
  if (Number.isNaN(startHour) || Number.isNaN(endHour)) {
    return undefined;
  }
  return { startHour, endHour };
}

export class FollowUpScanner {
  constructor(private readonly deps: FollowUpScannerDeps) {}

  /** 单轮扫描（测试可直接调用） */
  async tick(now = new Date()): Promise<ScanTickResult> {
    const { db, logger } = this.deps;
    const result: ScanTickResult = { scanned: 0, deferred: 0, enqueued: 0 };

    // ① 跨租户扫描到期跟进任务
    const due = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.sched', '1', true)`);
      return tx
        .select({
          id: schema.followUpTask.id,
          orgId: schema.followUpTask.orgId,
          customerId: schema.followUpTask.customerId,
          nextRunAt: schema.followUpTask.nextRunAt,
        })
        .from(schema.followUpTask)
        .where(
          and(
            inArray(schema.followUpTask.status, ['ready', 'scheduled']),
            lte(schema.followUpTask.nextRunAt, now),
          ),
        )
        .orderBy(schema.followUpTask.nextRunAt)
        .limit(BATCH_SIZE);
    });
    if (due.length === 0) {
      return result;
    }

    // ② 活跃 ai_task 防重快路径（同轮批量查一次；权威判重见 preCheck 行锁内复核）
    const dueIds = due.map((t) => t.id);
    const busy = new Set(
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.sched', '1', true)`);
        const rows = await tx
          .select({ followUpTaskId: sql<string>`(${schema.aiTask.input} ->> 'followUpTaskId')` })
          .from(schema.aiTask)
          .where(
            and(
              inArray(schema.aiTask.status, ['scheduled', 'running', 'waiting_approval']),
              // jsonb ->> 为 text，参数走 in（= any 数组参数在 PG 无法推断类型，42809）
              inArray(sql`(${schema.aiTask.input} ->> 'followUpTaskId')`, dueIds),
            ),
          );
        return rows.map((r) => r.followUpTaskId);
      }),
    );

    // ③ 逐任务 withOrg 预检（扫出后仍以 withOrg 执行，02 §4.3）
    for (const ft of due) {
      if (busy.has(ft.id)) {
        continue;
      }
      result.scanned += 1;
      try {
        const outcome = await this.preCheck(ft, now);
        if (outcome === 'deferred') {
          result.deferred += 1;
        } else if (outcome === 'enqueued') {
          result.enqueued += 1;
        }
      } catch (err) {
        logger.warn(
          { followUpTaskId: ft.id, err: err instanceof Error ? err.message : String(err) },
          '跟进任务预检失败，下轮重试',
        );
      }
    }
    return result;
  }

  /** 频控预检：'deferred'（顺延留痕）| 'enqueued'（已建 ai_task）| 'busy' */
  private async preCheck(
    ft: { id: string; orgId: string; customerId: string; nextRunAt: Date | null },
    now: Date,
  ): Promise<'deferred' | 'enqueued' | 'busy'> {
    const { db, logger } = this.deps;
    return withOrg(db, ft.orgId, async (tx) => {
      // ① 行锁领取（04 §3.1 SKIP LOCKED）：串行化同一 follow_up_task 的多实例并发预检；
      // 行已被他实例领取 / 状态已变（paused/completed）/ 已被顺延出窗口 → 让出。
      const claimed = await tx
        .select({ id: schema.followUpTask.id })
        .from(schema.followUpTask)
        .where(
          and(
            eq(schema.followUpTask.id, ft.id),
            inArray(schema.followUpTask.status, ['ready', 'scheduled']),
            lte(schema.followUpTask.nextRunAt, now),
          ),
        )
        .for('update', { skipLocked: true });
      if (claimed.length === 0) {
        return 'busy';
      }

      // ② 锁内复核活跃 ai_task：step② 快照可能过期（他实例刚提交），此处为准
      const [active] = await tx
        .select({ id: schema.aiTask.id })
        .from(schema.aiTask)
        .where(
          and(
            inArray(schema.aiTask.status, ['scheduled', 'running', 'waiting_approval']),
            sql`(${schema.aiTask.input} ->> 'followUpTaskId') = ${ft.id}`,
          ),
        )
        .limit(1);
      if (active) {
        return 'busy';
      }

      const [orgRow] = await tx
        .select({ timezone: schema.org.timezone, sendRules: schema.org.sendRules })
        .from(schema.org)
        .where(eq(schema.org.id, ft.orgId))
        .limit(1);
      const sendRules = (orgRow?.sendRules ?? null) as Record<string, unknown> | null;
      const minTouchIntervalDays = Number(sendRules?.['minTouchIntervalDays'] ?? 3);
      const window = parseSendWindow(sendRules);
      const timeZone = orgRow?.timezone ?? 'Asia/Shanghai';

      // L = 该客户最近一次 outbound 邮件（含人工，07 频控口径）
      const [lastOut] = await tx
        .select({ sentAt: schema.message.sentAt, createdAt: schema.message.createdAt })
        .from(schema.message)
        .innerJoin(schema.conversation, eq(schema.conversation.id, schema.message.conversationId))
        .where(
          and(
            eq(schema.conversation.customerId, ft.customerId),
            eq(schema.message.direction, 'out'),
            eq(schema.message.status, 'sent'),
          ),
        )
        .orderBy(desc(schema.message.createdAt))
        .limit(1);
      const lastOutboundAt = lastOut?.sentAt ?? lastOut?.createdAt ?? null;

      // 唯一公式：候选 = max(next_run_at, L + interval) → 窗口对齐
      const deferredAt = computeDeferredNextRunAt({
        now,
        nextRunAt: ft.nextRunAt ?? now,
        lastOutboundAt,
        minTouchIntervalDays,
        timeZone,
        ...(window ? { window } : {}),
      });

      if (ft.nextRunAt !== null && deferredAt.getTime() > ft.nextRunAt.getTime()) {
        // 频控/窗口不满足 → 乐观锁顺延 + skipped 留痕（不入队；顺延后不再被扫描）
        const updated = await tx
          .update(schema.followUpTask)
          .set({ nextRunAt: deferredAt, updatedAt: now })
          .where(
            and(
              eq(schema.followUpTask.id, ft.id),
              inArray(schema.followUpTask.status, ['ready', 'scheduled']),
              ft.nextRunAt === null
                ? sql`${schema.followUpTask.nextRunAt} is null`
                : eq(schema.followUpTask.nextRunAt, ft.nextRunAt),
            ),
          )
          .returning({ id: schema.followUpTask.id });
        if (updated.length === 0) {
          return 'busy';
        }
        await tx.insert(schema.followUpExecution).values({
          id: createId('fexc'),
          orgId: ft.orgId,
          followUpTaskId: ft.id,
          stepTitle: '频控顺延',
          status: 'skipped',
          skipReason: 'frequency_capped',
          sentAt: null,
        });
        logger.info(
          {
            followUpTaskId: ft.id,
            from: ft.nextRunAt?.toISOString(),
            to: deferredAt.toISOString(),
          },
          '频控预检未满足，顺延 next_run_at',
        );
        return 'deferred';
      }

      // 预检通过 → 建 ai_task（status=scheduled），由 Dispatcher 启动
      const [employee] = await tx
        .select({ id: schema.aiEmployee.id })
        .from(schema.aiEmployee)
        .where(and(eq(schema.aiEmployee.orgId, ft.orgId), eq(schema.aiEmployee.role, 'follow_up')))
        .orderBy(schema.aiEmployee.createdAt)
        .limit(1);
      if (!employee) {
        logger.warn(
          { orgId: ft.orgId, followUpTaskId: ft.id },
          'org 无 follow_up 角色 AI 员工，跳过本轮',
        );
        return 'busy';
      }

      // 触达容器：客户最近会话；无会话则建空会话（M3 mock 外发落 message 需要 conversationId）
      const [conv] = await tx
        .select({ id: schema.conversation.id })
        .from(schema.conversation)
        .where(
          and(
            eq(schema.conversation.orgId, ft.orgId),
            eq(schema.conversation.customerId, ft.customerId),
          ),
        )
        .orderBy(desc(schema.conversation.lastMessageAt))
        .limit(1);
      const conversationId =
        conv?.id ??
        (
          await tx
            .insert(schema.conversation)
            .values({
              id: createId('conv'),
              orgId: ft.orgId,
              customerId: ft.customerId,
              channel: 'email',
              subject: 'AI 自动跟进',
            })
            .returning({ id: schema.conversation.id })
        )[0]?.id;

      const inserted = await tx
        .insert(schema.aiTask)
        .values({
          id: createId('task'),
          orgId: ft.orgId,
          employeeId: employee.id,
          type: 'follow_up',
          title: 'AI 自动跟进触达',
          status: 'scheduled',
          input: { followUpTaskId: ft.id, customerId: ft.customerId, conversationId },
          createdBy: null,
        })
        .onConflictDoNothing()
        .returning({ id: schema.aiTask.id });
      if (inserted.length === 0) {
        // 兜底：并发实例已建活跃 ai_task（uq_ai_task_active_followup 唯一索引命中）
        logger.info(
          { followUpTaskId: ft.id, orgId: ft.orgId },
          '跟进任务活跃 ai_task 已存在（唯一索引兜底），跳过本轮',
        );
        return 'busy';
      }
      logger.info({ followUpTaskId: ft.id, orgId: ft.orgId }, '跟进到期，已建 follow_up 任务入队');
      return 'enqueued';
    });
  }
}
