/**
 * Tool Registry（后端技术方案 05 §3 / Runtime 总纲 §4.5）。
 * ToolDefinition = 工具唯一描述；校验链顺序固定（白名单 → scope → 风险分流 → 配额 → policy 细化），
 * 风险分流与审批闸门由 packages/runtime 的 ApprovalGate 编排（tools 包只提供元数据与钩子）。
 */
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { z } from 'zod';
import { schema, type Tx } from '@tradepilot/db';
import { BizException, ErrorCode, createId, zonedDayKey } from '@tradepilot/core';
import type { ApprovalType, RiskLevel, TaskLogType } from '@tradepilot/shared';

const { aiTaskLog } = schema;

/** 节点级工具执行上下文：tx 为 withOrg 事务（每节点一个事务，05 §2） */
export interface ToolContext {
  orgId: string;
  taskId: string;
  employeeId: string;
  nodeId: string;
  /** 任务类型（幂等键 / 频控口径用） */
  taskType: string;
  tx: Tx;
  redis: Redis;
  logger: Logger;
  now: Date;
  /** 任务级缓存（跨节点复用，如运行时数据） */
  bag: Map<string, unknown>;
  /** 写 ai_task_log（事务内）+ 登记待发布 SSE log 事件（事务提交后由 runner flush） */
  log(type: TaskLogType, content: string, leadId?: string): Promise<string>;
  /** 登记待发布 SSE 事件（事务提交后 flush；seq 由 publisher 生成） */
  emit(event: BufferedTaskEvent): void;
}

/** 缓冲事件（事务提交后发布，防止订阅方先于提交读库） */
export interface BufferedTaskEvent {
  type: 'log' | 'progress' | 'status' | 'done';
  payload: Record<string, unknown>;
}

export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  description: string;
  /** 入参即权限边界（AI 不可传 ownerId 等，03 §5） */
  inputSchema: z.ZodType<I>;
  riskLevel: RiskLevel;
  approvalType?: ApprovalType;
  /** 外部调用计权（06 §3：search ×1 / crawl ×2，缺省 0 = 不计外部配额） */
  quotaWeight?: 1 | 2;
  /** 审批 resume 后的新鲜度校验钩子（批准后、真实执行前，Runtime §4.7） */
  freshnessCheck?(ctx: ToolContext, input: I): Promise<boolean>;
  execute(ctx: ToolContext, input: I): Promise<O>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具重复注册: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new BizException(ErrorCode.NOT_FOUND, `工具未注册: ${name}`);
    }
    return tool;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 校验链①：员工 tools 白名单（越权 40301，Runtime §4.5） */
  assertAllowed(tool: ToolDefinition, employeeTools: readonly string[]): void {
    if (!employeeTools.includes(tool.name)) {
      throw new BizException(ErrorCode.FORBIDDEN, `员工未被授权使用工具: ${tool.name}`);
    }
  }

  /** 校验链②：入参 schema 校验 */
  parseInput<I>(tool: ToolDefinition<I>, input: unknown): I {
    const result = tool.inputSchema.safeParse(input);
    if (!result.success) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        `工具 ${tool.name} 入参不合法: ${result.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    return result.data;
  }

  /**
   * 校验链④：外部配额令牌桶（员工级 externalCallDailyLimit 默认 200，03 §3.7）。
   * M4 #6：日 key 按 org 时区墙钟日分片（zonedDayKey，06 §3 日界精确轮换；
   * TTL 48h 自动过期，QuotaReset 扫描器仅巡检留痕），超限 42901。
   * timezone 由调用方提供（TaskRunContext.org.timezone 快照，不在此查库）。
   */
  async assertQuota(
    ctx: Pick<ToolContext, 'orgId' | 'employeeId' | 'redis' | 'now'> & {
      timezone?: string | null;
    },
    tool: ToolDefinition,
    dailyLimit: number,
  ): Promise<void> {
    const weight = tool.quotaWeight ?? 0;
    if (weight === 0) {
      return;
    }
    const day = zonedDayKey(ctx.now, ctx.timezone || 'UTC');
    const key = `quota:${ctx.orgId}:${ctx.employeeId}:${day}`;
    const used = await ctx.redis.incrby(key, weight);
    if (used === weight) {
      await ctx.redis.expire(key, 48 * 3600);
    }
    if (used > dailyLimit) {
      throw new BizException(ErrorCode.RATE_LIMITED, `员工外部调用日额度已用尽（${dailyLimit}）`);
    }
  }
}

/** 工具/节点通用的日志写入（ai_task_log + SSE log 事件缓冲） */
export async function writeToolLog(
  ctx: ToolContext,
  type: TaskLogType,
  content: string,
  leadId?: string,
): Promise<string> {
  const logId = createId('tlog');
  await ctx.tx.insert(aiTaskLog).values({
    id: logId,
    orgId: ctx.orgId,
    taskId: ctx.taskId,
    occurredAt: ctx.now,
    type,
    content,
    leadId: leadId ?? null,
  });
  ctx.emit({ type: 'log', payload: { logId, type, content, ...(leadId ? { leadId } : {}) } });
  return logId;
}

/** 幂等键（04 §5.2）：taskId+nodeId（+salt，如 messageHash） */
export function toolIdempotencyKey(
  ctx: Pick<ToolContext, 'taskId' | 'nodeId'>,
  salt?: string,
): string {
  return salt ? `idem:${ctx.taskId}:${ctx.nodeId}:${salt}` : `idem:${ctx.taskId}:${ctx.nodeId}`;
}

/** 幂等执行：SET NX 抢占，重复调用返回 first=false（结果由 DB 状态承载，重试不重复外发） */
export async function withIdempotency<T>(
  ctx: ToolContext,
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<{ first: boolean; result: T }> {
  const ok = await ctx.redis.set(key, '1', 'EX', ttlSeconds, 'NX');
  if (ok !== 'OK') {
    return { first: false, result: undefined as T };
  }
  const result = await fn();
  return { first: true, result };
}
