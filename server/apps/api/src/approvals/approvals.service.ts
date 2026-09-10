import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { BizException, createId } from '@tradepilot/core';
import { schema, withOrg, type Db, type Tx } from '@tradepilot/db';
import type { MailboxDriverOptions } from '@tradepilot/integrations';
import {
  ApprovalGate,
  TaskEnqueuer,
  TaskEventPublisher,
  buildDoneEvent,
  buildStatusEvent,
  releaseEmployeeIdle,
} from '@tradepilot/runtime';
import type { TaskType } from '@tradepilot/shared';
import { DB } from '../db/db.module.js';
import { REDIS } from '../redis/redis.module.js';
import { PINO_ROOT } from '../common/logger/logger.factory.js';
import { EnvService } from '../config/env.service.js';
import { sendConversationEmail } from '../conversations/send-mail.helper.js';
import type { ApproveApprovalDto, RejectApprovalDto } from './approvals.dto.js';

/**
 * 审核中心服务（接口 12 §3 / Runtime §4.7 审批闭环）：
 * - summary：各类型待审数量（Tab，含 all；P0 来源=email_send+customer_delete 常驻展示）；
 * - approve / reject：仅 pending 可处置（expired → 42201，已处置 → 40901），approval_log 留痕；
 *   approve（含编辑）→ 按业务类型回调原动作：ai_task → markResumed + q:重投
 *   （job.data.resume={nodeId,approvalId}）恢复图执行（发送前新鲜度校验由工具钩子执行，Runtime §4.7）；
 *   reject → 级联 ai_task.failed(approval_rejected) + follow_up_task.paused 转人工（与超时扫描同口径）。
 * - 直接消息审批（M5-C1 send 分支 B）：bizType='message' —— approve → mailbox 驱动真实外发
 *   该消息 + message.status='sent'（resultRef={messageId,status:'sent'}）；reject → message.status 回退 draft。
 * - auto_approve 留痕已由 worker 侧 ApprovalGate.recordAutoApprove 承载（12 §4 风险分级口径）。
 */
@Injectable()
export class ApprovalsService {
  private readonly enqueuer: TaskEnqueuer;
  private readonly gate: ApprovalGate;
  private readonly publisher: TaskEventPublisher;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PINO_ROOT) private readonly logger: Logger,
    @Inject(EnvService) private readonly env: EnvService,
  ) {
    this.enqueuer = new TaskEnqueuer(env.env.REDIS_URL);
    this.publisher = new TaskEventPublisher(redis);
    this.gate = new ApprovalGate(db, redis, this.publisher, logger);
  }

  /** 邮箱驱动选项（凭据解密 + OAuth 客户端凭据，06 §2.4） */
  private get driverOptions(): MailboxDriverOptions {
    const env = this.env.env;
    return {
      encryptionKey: env.ENCRYPTION_KEY,
      oauth: {
        googleClientId: env.GOOGLE_CLIENT_ID || undefined,
        googleClientSecret: env.GOOGLE_CLIENT_SECRET || undefined,
        microsoftClientId: env.MICROSOFT_CLIENT_ID || undefined,
        microsoftClientSecret: env.MICROSOFT_CLIENT_SECRET || undefined,
      },
    };
  }

  /** 12 §3.1 各类型待审数量（Tab） */
  async summary(orgId: string): Promise<{ tabs: { type: string; count: number }[] }> {
    return withOrg(this.db, orgId, async (tx) => {
      const rows = await tx
        .select({ type: schema.approvalRequest.approvalType, n: count() })
        .from(schema.approvalRequest)
        .where(
          and(
            eq(schema.approvalRequest.orgId, orgId),
            eq(schema.approvalRequest.status, 'pending'),
          ),
        )
        .groupBy(schema.approvalRequest.approvalType);
      const byType = new Map(rows.map((r) => [r.type as string, Number(r.n)]));
      const total = rows.reduce((sum, r) => sum + Number(r.n), 0);
      // all + P0 常驻类型（email_send/customer_delete：count=0 也保留 Tab 入口，与前端 mock 契约一致）
      // + 其余 count>0 的类型（12 §3.1 Tab 口径；D10 前端只渲染服务端返回的类型）
      const p0Types = ['email_send', 'customer_delete'];
      const tabs: { type: string; count: number }[] = [{ type: 'all', count: total }];
      for (const type of p0Types) {
        tabs.push({ type, count: byType.get(type) ?? 0 });
      }
      for (const [type, n] of byType) {
        if (n > 0 && !p0Types.includes(type)) {
          tabs.push({ type, count: n });
        }
      }
      return { tabs };
    });
  }

  /** 12 §3.2 审批列表（type/status 筛选 + 分页） */
  async list(
    orgId: string,
    query: { type?: string; status?: string; page: number; pageSize: number },
  ): Promise<{ items: Record<string, unknown>[]; total: number; page: number; pageSize: number }> {
    return withOrg(this.db, orgId, async (tx) => {
      const conds = [eq(schema.approvalRequest.orgId, orgId)];
      if (query.type) {
        conds.push(sql`${schema.approvalRequest.approvalType} = ${query.type}`);
      }
      if (query.status === 'processed') {
        // 已处置历史（12 §3.2）：approve/edited_approved/rejected/auto_approved（expired 超时终态不列入）
        conds.push(
          inArray(schema.approvalRequest.status, [
            'approved',
            'edited_approved',
            'rejected',
            'auto_approved',
          ]),
        );
      } else if (query.status) {
        conds.push(sql`${schema.approvalRequest.status} = ${query.status}`);
      }
      const where = and(...conds);
      const rows = await tx
        .select({
          row: schema.approvalRequest,
          approverName: schema.userAccount.name,
        })
        .from(schema.approvalRequest)
        .leftJoin(schema.userAccount, eq(schema.userAccount.id, schema.approvalRequest.decidedBy))
        .where(where)
        .orderBy(desc(schema.approvalRequest.createdAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);
      const [total] = await tx.select({ n: count() }).from(schema.approvalRequest).where(where);
      return {
        items: rows.map((r) => this.toCard(r.row, r.approverName)),
        total: Number(total?.n ?? 0),
        page: query.page,
        pageSize: query.pageSize,
      };
    });
  }

  /** 12 §1.2 审核卡片详情 */
  async detail(orgId: string, approvalId: string) {
    return withOrg(this.db, orgId, async (tx) => {
      const [row] = await tx
        .select({
          row: schema.approvalRequest,
          approverName: schema.userAccount.name,
        })
        .from(schema.approvalRequest)
        .leftJoin(schema.userAccount, eq(schema.userAccount.id, schema.approvalRequest.decidedBy))
        .where(
          and(eq(schema.approvalRequest.id, approvalId), eq(schema.approvalRequest.orgId, orgId)),
        )
        .limit(1);
      if (!row) {
        throw BizException.notFound(`审批单不存在: ${approvalId}`);
      }
      return this.toCard(row.row, row.approverName);
    });
  }

  /** 12 §3.3 批准（可带编辑后内容；回调原业务动作 = 恢复 AI 任务执行） */
  async approve(orgId: string, userId: string, approvalId: string, dto: ApproveApprovalDto) {
    const decided = await withOrg(this.db, orgId, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.approvalRequest)
        .where(
          and(eq(schema.approvalRequest.id, approvalId), eq(schema.approvalRequest.orgId, orgId)),
        )
        .limit(1);
      if (!row) {
        throw BizException.notFound(`审批单不存在: ${approvalId}`);
      }
      if (row.status === 'expired') {
        throw BizException.bizValidation(
          '审批已超时关闭（expired 终态），请重新生成任务（12 §3.3）',
        );
      }
      if (row.status !== 'pending') {
        throw BizException.conflict(`审批已处置（当前状态: ${row.status}），不可重复处置`);
      }

      const now = new Date();
      const status = dto.action === 'edited_approved' ? 'edited_approved' : 'approved';
      const beforeProposal = row.aiProposal ?? {};
      const mergedProposal =
        status === 'edited_approved'
          ? { ...beforeProposal, ...(dto.editedContent?.aiProposal ?? {}) }
          : beforeProposal;
      // 统一字段级 before/after 差异表（12 §1.4；长文本整体替换留痕同口径）
      const editedDiff = computeEditedDiff(beforeProposal, mergedProposal);

      // resultRef：按业务类型回调原业务动作（12 §3.3）
      let resultRef: Record<string, unknown> | null = null;

      // customer_delete 批准 → 执行真删（05 §3.3：删除动作由本审批闭环，批准后才落 deletedAt）
      if (row.approvalType === 'customer_delete') {
        const cid = this.customerIdOf(row);
        if (cid) {
          await tx
            .update(schema.customer)
            .set({ deletedAt: now, updatedAt: now })
            .where(and(eq(schema.customer.id, cid), eq(schema.customer.orgId, orgId)));
        }
      }

      if (row.approvalType === 'email_send' && row.bizType === 'message') {
        // M5-C1 send 分支 B：批准 → mailbox 真实外发 + message.status='sent'
        resultRef = await this.executeMessageSend(tx, orgId, row, mergedProposal, now);
      } else if (row.linkedTaskId) {
        // AI 任务审批：事务提交后 resume 恢复图执行（见下方 enqueueResume）
        resultRef = { taskId: row.linkedTaskId };
      }

      await tx
        .update(schema.approvalRequest)
        .set({
          status,
          aiProposal: mergedProposal,
          decidedBy: userId,
          decidedAt: now,
          resultRef,
          updatedAt: now,
        })
        .where(eq(schema.approvalRequest.id, approvalId));

      const [approver] = await tx
        .select({ name: schema.userAccount.name })
        .from(schema.userAccount)
        .where(eq(schema.userAccount.id, userId))
        .limit(1);
      await tx.insert(schema.approvalLog).values({
        id: createId('alog'),
        orgId,
        approvalId,
        action: status,
        approverId: userId,
        approverName: approver?.name ?? String(userId),
        editedDiff: editedDiff.length > 0 ? editedDiff : null,
        decidedAt: now,
      });

      // 任务侧信息（resume 恢复用）
      let taskType: string | null = null;
      let employeeId = row.requestedByEmployeeId ?? null;
      if (row.linkedTaskId) {
        const [task] = await tx
          .select({ type: schema.aiTask.type, employeeId: schema.aiTask.employeeId })
          .from(schema.aiTask)
          .where(eq(schema.aiTask.id, row.linkedTaskId))
          .limit(1);
        taskType = task?.type ?? null;
        employeeId = task?.employeeId ?? employeeId;
      }
      return {
        status,
        linkedTaskId: row.linkedTaskId,
        taskType,
        employeeId,
        nodeId: typeof row.aiProposal?.['nodeId'] === 'string' ? row.aiProposal['nodeId'] : null,
        resultRef,
      };
    });

    // 事务提交后恢复执行：waiting_approval → running + resume 重投（Runner 从挂起节点续跑）
    if (
      (decided.status === 'approved' || decided.status === 'edited_approved') &&
      decided.linkedTaskId &&
      decided.taskType &&
      decided.nodeId
    ) {
      await this.gate.markResumed(orgId, decided.linkedTaskId, decided.employeeId ?? '');
      await this.enqueuer.enqueueResume(decided.linkedTaskId, decided.taskType as TaskType, {
        nodeId: decided.nodeId,
        approvalId,
      });
    }

    return {
      approvalId,
      status: decided.status,
      resultRef: decided.resultRef,
    };
  }

  /** 12 §3.4 拒绝（必填原因；级联任务失败转人工，reason 回流 AI 员工反馈闭环） */
  async reject(orgId: string, userId: string, approvalId: string, dto: RejectApprovalDto) {
    const decided = await withOrg(this.db, orgId, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.approvalRequest)
        .where(
          and(eq(schema.approvalRequest.id, approvalId), eq(schema.approvalRequest.orgId, orgId)),
        )
        .limit(1);
      if (!row) {
        throw BizException.notFound(`审批单不存在: ${approvalId}`);
      }
      if (row.status === 'expired') {
        throw BizException.bizValidation('审批已超时关闭（expired 终态），无需处置（12 §3.4）');
      }
      if (row.status !== 'pending') {
        throw BizException.conflict(`审批已处置（当前状态: ${row.status}），不可重复处置`);
      }

      const now = new Date();
      await tx
        .update(schema.approvalRequest)
        .set({
          status: 'rejected',
          decidedBy: userId,
          decidedAt: now,
          updatedAt: now,
          // 拒绝原因回写（AI 员工反馈闭环，12 §3.4）
          context: { ...(row.context ?? {}), rejectReason: dto.reason },
        })
        .where(eq(schema.approvalRequest.id, approvalId));

      const [approver] = await tx
        .select({ name: schema.userAccount.name })
        .from(schema.userAccount)
        .where(eq(schema.userAccount.id, userId))
        .limit(1);
      await tx.insert(schema.approvalLog).values({
        id: createId('alog'),
        orgId,
        approvalId,
        action: 'rejected',
        approverId: userId,
        approverName: approver?.name ?? String(userId),
        rejectReason: dto.reason,
        decidedAt: now,
      });

      // customer_delete 拒绝 → 自动解锁「删除待审」（05 §3.3 / 12 §3.4；客户保留）
      if (row.approvalType === 'customer_delete') {
        const cid = this.customerIdOf(row);
        if (cid) {
          await tx
            .update(schema.customer)
            .set({ deleteLocked: false, updatedAt: now })
            .where(and(eq(schema.customer.id, cid), eq(schema.customer.orgId, orgId)));
        }
      }

      // 直接消息审批拒绝 → message.status 回退 draft，可编辑重发（M5-C1 send 分支 B / 12 §3.4 闭环）
      if (row.approvalType === 'email_send' && row.bizType === 'message') {
        await tx
          .update(schema.message)
          .set({ status: 'draft', updatedAt: now })
          .where(
            and(
              eq(schema.message.id, row.bizId),
              eq(schema.message.orgId, orgId),
              eq(schema.message.status, 'waiting_approval'),
            ),
          );
      }

      // 级联 ai_task.failed(approval_rejected) + follow_up_task.paused 转人工（与超时扫描同口径）
      let failedTaskId: string | null = null;
      if (row.linkedTaskId) {
        const [before] = await tx
          .select({ input: schema.aiTask.input })
          .from(schema.aiTask)
          .where(eq(schema.aiTask.id, row.linkedTaskId))
          .limit(1);
        const [taskRow] = await tx
          .update(schema.aiTask)
          .set({
            status: 'failed',
            error: 'approval_rejected',
            finishedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.aiTask.id, row.linkedTaskId),
              eq(schema.aiTask.status, 'waiting_approval'),
            ),
          )
          .returning({ id: schema.aiTask.id, employeeId: schema.aiTask.employeeId });
        if (taskRow) {
          failedTaskId = taskRow.id;
          const released = await releaseEmployeeIdle(tx, {
            employeeId: taskRow.employeeId,
            excludeTaskId: taskRow.id,
            now,
          });
          if (!released) {
            this.logger.warn(
              { taskId: taskRow.id, employeeId: taskRow.employeeId },
              '审批拒绝级联失败但员工仍占用其它任务，保持员工状态',
            );
          }
          const followUpTaskId =
            typeof before?.input?.['followUpTaskId'] === 'string'
              ? before.input['followUpTaskId']
              : null;
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
      return { status: 'rejected', failedTaskId };
    });

    // SSE：任务侧 failed + done（拒绝即终态，无 resume）
    if (decided.failedTaskId) {
      await this.publisher.publish(
        decided.failedTaskId,
        buildStatusEvent({ status: 'failed', error: 'approval_rejected' }),
      );
      await this.publisher.publish(
        decided.failedTaskId,
        buildDoneEvent({ status: 'failed', outputs: [], error: 'approval_rejected' }),
      );
    }

    return { approvalId, status: 'rejected' };
  }

  /** 12 §1.5 审核留痕记录 */
  async logs(orgId: string, approvalId: string) {
    return withOrg(this.db, orgId, async (tx) => {
      const [req] = await tx
        .select({ id: schema.approvalRequest.id })
        .from(schema.approvalRequest)
        .where(
          and(eq(schema.approvalRequest.id, approvalId), eq(schema.approvalRequest.orgId, orgId)),
        )
        .limit(1);
      if (!req) {
        throw BizException.notFound(`审批单不存在: ${approvalId}`);
      }
      const rows = await tx
        .select({
          id: schema.approvalLog.id,
          action: schema.approvalLog.action,
          approverName: schema.approvalLog.approverName,
          editedDiff: schema.approvalLog.editedDiff,
          rejectReason: schema.approvalLog.rejectReason,
          decidedAt: schema.approvalLog.decidedAt,
        })
        .from(schema.approvalLog)
        .where(eq(schema.approvalLog.approvalId, approvalId))
        .orderBy(desc(schema.approvalLog.decidedAt));
      // 12 §1.5 留痕记录：直接返回数组（前端 ApprovalLog[] 契约 / mock 一致）
      return rows.map((r) => ({
        logId: r.id,
        approvalId,
        approverName: r.approverName,
        action: r.action,
        ...(r.editedDiff ? { editedDiff: r.editedDiff } : {}),
        ...(r.rejectReason ? { rejectReason: r.rejectReason } : {}),
        decidedAt: r.decidedAt.toISOString(),
      }));
    });
  }

  /**
   * 直接消息审批批准 → 回调原业务动作「真实外发」（M5-C1 send 分支 B / 12 §3.3）：
   * 走 06 §2.4 唯一发信出口（mailbox 驱动）发送 mergedProposal.emailContent（编辑后批准以编辑稿为准），
   * 回写 message.status='sent' + 会话摘要；无可用邮箱 → 42201（与 send 分支 A 同口径，审批保持 pending）。
   */
  private async executeMessageSend(
    tx: Tx,
    orgId: string,
    row: typeof schema.approvalRequest.$inferSelect,
    mergedProposal: Record<string, unknown>,
    now: Date,
  ): Promise<Record<string, unknown>> {
    const messageId = row.bizId;
    const conversationId = stringOf(row.context?.['conversationId']);
    if (!conversationId) {
      throw BizException.bizValidation('审批单缺少会话上下文，无法外发（12 §3.3）');
    }
    const [message] = await tx
      .select()
      .from(schema.message)
      .where(and(eq(schema.message.id, messageId), eq(schema.message.orgId, orgId)))
      .limit(1);
    if (!message) {
      throw BizException.notFound(`待发消息不存在: ${messageId}`);
    }
    const edited = stringOf(mergedProposal['emailContent']);
    const content = edited && edited.length > 0 ? edited : message.content;
    const subject = stringOf(row.context?.['subject']) ?? '（无主题）';
    const { externalId } = await sendConversationEmail(
      tx,
      orgId,
      conversationId,
      subject,
      content,
      this.driverOptions,
    );
    await tx
      .update(schema.message)
      .set({
        content,
        status: 'sent',
        sentAt: now,
        externalMessageId: externalId,
        updatedAt: now,
      })
      .where(eq(schema.message.id, messageId));
    await tx
      .update(schema.conversation)
      .set({ lastMessageAt: now, lastMessagePreview: content.slice(0, 120), updatedAt: now })
      .where(eq(schema.conversation.id, conversationId));
    return { messageId, status: 'sent' };
  }

  /** customer_delete 审批指向的客户 id（context.customerId 优先，兼容历史数据回退 bizId） */
  private customerIdOf(row: typeof schema.approvalRequest.$inferSelect): string | null {
    const cid = row.context?.['customerId'];
    if (typeof cid === 'string' && cid.length > 0) {
      return cid;
    }
    return row.approvalType === 'customer_delete' && typeof row.bizId === 'string'
      ? row.bizId
      : null;
  }

  /** 行 → 审核卡片（12 §1.2 字段口径；已处置态补充处置人/理由） */
  private toCard(
    row: typeof schema.approvalRequest.$inferSelect,
    approverName?: string | null,
  ): Record<string, unknown> {
    const rejectReason = stringOf(row.context?.['rejectReason']);
    return {
      approvalId: row.id,
      approvalType: row.approvalType,
      riskLevel: row.riskLevel,
      title: row.title,
      status: row.status,
      context: row.context ?? {},
      aiProposal: row.aiProposal ?? {},
      confidence: row.confidence === null ? null : Number(row.confidence),
      reasons: row.reasons ?? [],
      createdAt: row.createdAt.toISOString(),
      ...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
      ...(row.decidedAt ? { decidedAt: row.decidedAt.toISOString() } : {}),
      ...(approverName ? { approverName } : {}),
      ...(rejectReason ? { rejectReason } : {}),
    };
  }
}

/** 读取字符串字段（非字符串 / 空串 → null） */
function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 字段级 before/after 差异（12 §1.4 editedDiff）：
 * - field 以 `aiProposal.` 前缀标注来源（与前端 mock 契约一致，如 `aiProposal.emailContent`）；
 * - 字符串值原样透出（长文本整体替换留痕），非字符串值 JSON 字符串化。
 */
function computeEditedDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { field: string; before: string; after: string }[] {
  const diff: { field: string; before: string; after: string }[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const b = itemString(before[key]);
    const a = itemString(after[key]);
    if (b !== a) {
      diff.push({ field: `aiProposal.${key}`, before: b, after: a });
    }
  }
  return diff;
}

function itemString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  return JSON.stringify(value);
}
