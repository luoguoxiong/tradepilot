/**
 * Approval Gate（后端技术方案 05 §4 / Runtime 总纲 §4.7）。
 * 分流放行链（顺序判定，全部通过才直发）：
 *   ① riskLevel=high → 必人工
 *   ② medium 强制人工例外（Break-up Email / approval_policy.email_send='always' / 'high_value_only' 且客户 tier=high）→ 必人工
 *   ③ org autoApprove（16 FR-08，仅 medium）+ 员工 approval_policy.autoExecute 含该类型 → 直发留痕
 *   ④ 其余 → 人工审批（interrupt）
 * 挂起即冻结：waiting_approval 不占 org 并发额度（org 仅统计 running），但占员工位（04 §3.3，M3-06）；
 * follow_up_task.status 同步 waiting_approval、next_run_at 冻结原值（排期单一写入口约束）。
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { schema, withOrg, type Db, type Tx } from '@tradepilot/db';
import { createId } from '@tradepilot/core';
import { APPROVAL_STATUS, TASK_STATUS, TASK_LOG_TYPE } from '@tradepilot/shared';
import type { TaskEventPublisher } from './events.js';
import { buildStatusEvent } from './events.js';
import type { TaskRunContext } from './context.js';

/** 审批超时缺省 48h（12 §7.2；16 设置可按 approvalType 配置覆盖——M3-14 接入 org.approvalTtlMsByType） */
export const APPROVAL_TTL_MS = 48 * 3600 * 1000;

/**
 * 审批超时解析（M3-14，12 §7.2「按类型默认 48h，16 可配」）：
 * 员工角色 approval_rules 中本类型 expireHours → 毫秒；未配置/非法值回落 48h 常量。
 */
export function approvalTtlMs(ctx: TaskRunContext, tool: GateToolMeta): number {
  const configured = ctx.org.approvalTtlMsByType[tool.approvalType ?? tool.name];
  return typeof configured === 'number' && configured > 0 ? configured : APPROVAL_TTL_MS;
}

export interface GateVerdict {
  action: 'execute' | 'auto_approve' | 'interrupt';
  /** 中断前置态的审批单 id（enterWaiting 产出） */
  approvalId?: string;
  reason: string;
}

/** Gate 判定所需的最小工具元数据（来自 ToolDefinition） */
export interface GateToolMeta {
  name: string;
  riskLevel: 'low' | 'medium' | 'high';
  approvalType?: string;
}

export class ApprovalGate {
  constructor(
    private readonly db: Db,
    private readonly redis: Redis,
    private readonly publisher: TaskEventPublisher,
    private readonly logger: Logger,
  ) {}

  /** 分流放行链（不落库；interrupt 前置态由 enterWaiting 落库） */
  async decide(
    tool: GateToolMeta,
    ctx: TaskRunContext,
    input: Record<string, unknown>,
  ): Promise<GateVerdict> {
    // ① high 一律人工
    if (tool.riskLevel === 'high') {
      return { action: 'interrupt', reason: 'high 风险操作强制人工审批（Runtime §4.7）' };
    }

    // ② 强制人工例外优先于 autoApprove
    const forced = await this.forcedManualReason(tool, ctx, input);
    if (forced) {
      return { action: 'interrupt', reason: forced };
    }

    // ③ org autoApprove + 员工 autoExecute 白名单 → 直发留痕
    const orgAuto = ctx.org.autoApproveTypes.includes(tool.approvalType ?? tool.name);
    const autoExecute = ctx.employee.approvalPolicy.autoExecute ?? [];
    const employeeAuto =
      autoExecute.includes(tool.name) || autoExecute.includes(tool.approvalType ?? '');
    if (tool.riskLevel === 'medium' && orgAuto && employeeAuto) {
      return {
        action: 'auto_approve',
        reason: 'org autoApprove + 员工 autoExecute 命中，自动放行留痕',
      };
    }

    // ④ 其余 → 人工审批
    return { action: 'interrupt', reason: 'medium 风险操作需人工审批' };
  }

  /** 强制人工例外判定（②） */
  private async forcedManualReason(
    tool: GateToolMeta,
    ctx: TaskRunContext,
    input: Record<string, unknown>,
  ): Promise<string | null> {
    if (tool.approvalType !== 'email_send' && tool.name !== 'email_send') {
      return null;
    }
    // Break-up Email 一律人工审（07 §4）
    if (input['contentKind'] === 'breakup') {
      return 'Break-up Email 强制人工审核（07 §4）';
    }
    const policy = ctx.employee.approvalPolicy.email_send;
    if (policy === 'always') {
      return '员工 approval_policy.email_send=always，强制人工审批（02 §2）';
    }
    if (policy === 'high_value_only') {
      const customerId = typeof input['customerId'] === 'string' ? input['customerId'] : null;
      const tier = customerId ? await this.customerTier(ctx, customerId) : 'low';
      if (tier === 'high') {
        return '高价值客户发送强制人工审批（high_value_only，02 §2）';
      }
    }
    return null;
  }

  private async customerTier(
    ctx: TaskRunContext,
    customerId: string,
  ): Promise<'high' | 'medium' | 'low'> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const [row] = await tx
        .select({ score: schema.customer.score })
        .from(schema.customer)
        .where(eq(schema.customer.id, customerId))
        .limit(1);
      const score = row?.score ?? 0;
      return score >= 85 ? 'high' : score >= 60 ? 'medium' : 'low';
    });
  }

  /**
   * interrupt 前置落库（幂等，重跑安全）：单事务写 approval_request + ai_task.waiting_approval +
   * linked_approval_id + follow_up_task 状态同步 + 员工状态 + SSE status 事件。
   */
  async enterWaiting(
    tool: GateToolMeta,
    ctx: TaskRunContext,
    input: Record<string, unknown>,
  ): Promise<string> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      // 幂等：同 (task, node) 已有 pending 审批单则复用（resume 重放节点时防重复建单）
      const [existing] = await tx
        .select({ id: schema.approvalRequest.id })
        .from(schema.approvalRequest)
        .where(
          and(
            eq(schema.approvalRequest.orgId, ctx.orgId),
            eq(schema.approvalRequest.bizType, 'ai_task'),
            eq(schema.approvalRequest.bizId, ctx.taskId),
            sql`${schema.approvalRequest.aiProposal} ->> 'nodeId' = ${ctx.nodeId}`,
            eq(schema.approvalRequest.status, APPROVAL_STATUS.PENDING),
          ),
        )
        .limit(1);

      let approvalId: string;
      if (existing) {
        approvalId = existing.id;
      } else {
        approvalId = createId('appr');
        await tx.insert(schema.approvalRequest).values({
          id: approvalId,
          orgId: ctx.orgId,
          approvalType: (tool.approvalType ?? 'email_send') as never,
          riskLevel: tool.riskLevel,
          title: ctx.task.title,
          bizType: 'ai_task',
          bizId: ctx.taskId,
          context: { taskId: ctx.taskId, nodeId: ctx.nodeId, taskType: ctx.taskType },
          aiProposal: { nodeId: ctx.nodeId, tool: tool.name, input },
          confidence: null,
          reasons: [],
          status: APPROVAL_STATUS.PENDING,
          requestedByEmployeeId: ctx.employeeId,
          linkedTaskId: ctx.taskId,
          expiresAt: new Date(ctx.now.getTime() + approvalTtlMs(ctx, tool)),
        });
      }

      // ai_task → waiting_approval（幂等：已处于 waiting_approval 不重复写）
      await tx
        .update(schema.aiTask)
        .set({
          status: TASK_STATUS.WAITING_APPROVAL,
          linkedApprovalId: approvalId,
          updatedAt: ctx.now,
        })
        .where(and(eq(schema.aiTask.id, ctx.taskId), eq(schema.aiTask.orgId, ctx.orgId)));

      // follow_up_task 同步挂起（next_run_at 冻结原值，不写排期）
      const followUpTaskId = ctx.task.input['followUpTaskId'];
      if (typeof followUpTaskId === 'string') {
        await tx
          .update(schema.followUpTask)
          .set({ status: 'waiting_approval', updatedAt: ctx.now })
          .where(
            and(
              eq(schema.followUpTask.id, followUpTaskId),
              eq(schema.followUpTask.status, 'scheduled'),
            ),
          );
      }

      // 员工卡片状态
      await tx
        .update(schema.aiEmployee)
        .set({ status: 'waiting_approval', updatedAt: ctx.now })
        .where(eq(schema.aiEmployee.id, ctx.employeeId));

      ctx.events.push(
        buildStatusEvent({ status: TASK_STATUS.WAITING_APPROVAL, linkedApprovalId: approvalId }),
      );
      this.logger.info({ taskId: ctx.taskId, approvalId, tool: tool.name }, '任务进入审批挂起');
      return approvalId;
    });
  }

  /** autoApprove 直发留痕：approval_request(auto_approved) + approval_log（12 §7.1 口径） */
  async recordAutoApprove(
    tool: GateToolMeta,
    ctx: TaskRunContext,
    input: Record<string, unknown>,
  ): Promise<string> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const approvalId = createId('appr');
      const approverId = await resolveSystemApproverId(tx, ctx.orgId, ctx.taskId);
      await tx.insert(schema.approvalRequest).values({
        id: approvalId,
        orgId: ctx.orgId,
        approvalType: (tool.approvalType ?? 'email_send') as never,
        riskLevel: tool.riskLevel,
        title: ctx.task.title,
        bizType: 'ai_task',
        bizId: ctx.taskId,
        context: { taskId: ctx.taskId, nodeId: ctx.nodeId, taskType: ctx.taskType },
        aiProposal: { nodeId: ctx.nodeId, tool: tool.name, input },
        reasons: [],
        status: APPROVAL_STATUS.AUTO_APPROVED,
        requestedByEmployeeId: ctx.employeeId,
        linkedTaskId: ctx.taskId,
        expiresAt: new Date(ctx.now.getTime() + approvalTtlMs(ctx, tool)),
        decidedAt: ctx.now,
      });
      if (approverId) {
        await tx.insert(schema.approvalLog).values({
          id: createId('alog'),
          orgId: ctx.orgId,
          approvalId,
          action: APPROVAL_STATUS.AUTO_APPROVED,
          approverId,
          approverName: '系统（autoApprove）',
          decidedAt: ctx.now,
        });
      }
      ctx.events.push({
        type: 'log',
        payload: {
          type: TASK_LOG_TYPE.FOUND,
          content: `命中 autoApprove，自动放行（${tool.name}）`,
        },
      });
      return approvalId;
    });
  }

  /**
   * 审批处置后恢复运行（12 接口回调 worker 时调用）：
   * 任务 waiting_approval → running、员工 → working；follow_up_task 保持 scheduled（排期冻结解除）。
   * 新鲜度校验在图内 resume 后由工具钩子执行（Runtime §4.7）。
   */
  async markResumed(
    orgId: string,
    taskId: string,
    employeeId: string,
    now = new Date(),
  ): Promise<void> {
    await withOrg(this.db, orgId, async (tx) => {
      await tx
        .update(schema.aiTask)
        .set({ status: TASK_STATUS.RUNNING, updatedAt: now })
        .where(
          and(eq(schema.aiTask.id, taskId), eq(schema.aiTask.status, TASK_STATUS.WAITING_APPROVAL)),
        );
      const followUpTaskId = (
        await tx
          .select({ input: schema.aiTask.input })
          .from(schema.aiTask)
          .where(eq(schema.aiTask.id, taskId))
          .limit(1)
      )[0]?.input['followUpTaskId'];
      if (typeof followUpTaskId === 'string') {
        await tx
          .update(schema.followUpTask)
          .set({ status: 'scheduled', updatedAt: now })
          .where(
            and(
              eq(schema.followUpTask.id, followUpTaskId),
              eq(schema.followUpTask.status, 'waiting_approval'),
            ),
          );
      }
      await tx
        .update(schema.aiEmployee)
        .set({ status: 'working', updatedAt: now })
        .where(
          and(
            eq(schema.aiEmployee.id, employeeId),
            eq(schema.aiEmployee.status, 'waiting_approval'),
          ),
        );
    });
    await this.publisher.publish(taskId, buildStatusEvent({ status: TASK_STATUS.RUNNING }));
  }
}

/** 系统/自动留痕的 approver 兜底：任务创建人 → org 首个管理员（approval_log.approver_id NOT NULL 约束） */
export async function resolveSystemApproverId(
  tx: Tx,
  orgId: string,
  taskId: string,
): Promise<string | null> {
  const [task] = await tx
    .select({ createdBy: schema.aiTask.createdBy })
    .from(schema.aiTask)
    .where(eq(schema.aiTask.id, taskId))
    .limit(1);
  if (task?.createdBy) {
    return task.createdBy;
  }
  const [admin] = await tx
    .select({ id: schema.userAccount.id })
    .from(schema.userAccount)
    .where(and(eq(schema.userAccount.orgId, orgId), eq(schema.userAccount.role, 'admin')))
    .limit(1);
  return admin?.id ?? null;
}
