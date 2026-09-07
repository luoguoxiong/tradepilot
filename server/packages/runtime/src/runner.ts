/**
 * TaskRunner（后端技术方案 04 §5 / Runtime 总纲 §4）：
 * ① 跨租户定位任务（app.sched 放行，02 §4.3）→ ② 乐观锁领取（幂等第二层；scheduled→running，
 * resume 路由 waiting_approval/running 续跑）→ ③ 加载员工/org 快照组装 TaskRunContext →
 * ④ 图执行（初始 State = BaseTaskState + input 同名键播种；心跳 task:{id}:heartbeat 30s/90s）→
 * 终态：completed+outputs / ApprovalPendingError（gate 已落 waiting_approval，仅 flush 事件）/
 * failed+error；员工空闲回写前做前置校验（M3-06：无其它 active 任务才置 idle），SSE status/done 推送。
 * 员工并发=1（running/waiting_approval 占员工位）与 org 并发=10 的领取闸门在
 * worker Dispatcher / API 直投判定 / DelayedJobReconciler（04 §3.3；不归 runner）。
 */
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { and, eq, sql } from 'drizzle-orm';
import { schema, withOrg, type Db } from '@tradepilot/db';
import { BizException, ErrorCode } from '@tradepilot/core';
import { EMPLOYEE_STATUS, TASK_STATUS, type TaskType } from '@tradepilot/shared';
import type { GraphCompiler } from './compiler.js';
import { BRANCH_KEY, ApprovalPendingError } from './compiler.js';
import type { EmployeeRuntime, OrgApprovalRule, OrgRuntime, TaskRunContext } from './context.js';
import type { TaskEventPublisher } from './events.js';
import { buildDoneEvent, buildStatusEvent, flushBufferedEvents } from './events.js';
import { releaseEmployeeIdle } from './release-employee.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TTL_S = 90;
/** 员工外部调用日配额缺省（03 §3.7：默认 200） */
const DEFAULT_EXTERNAL_CALL_LIMIT = 200;

/** taskType → { sop 图定义, State 通道键 }（workflows 内置三图；org 自定义 SOP 随 P1） */
export interface TaskSopProvider {
  get(taskType: string): { sop: unknown; stateKeys: string[] };
}

/** 审批通过后的续跑指引（12 处置接口重入队时随 job 携带） */
export interface ResumeHint {
  /** 挂起的工具节点 id（approval_request.aiProposal.nodeId） */
  nodeId: string;
  approvalId: string;
}

export interface TaskRunnerDeps {
  db: Db;
  redis: Redis;
  logger: Logger;
  publisher: TaskEventPublisher;
  compiler: GraphCompiler;
  sops: TaskSopProvider;
}

export interface RunTaskResult {
  status: 'completed' | 'waiting_approval' | 'failed' | 'skipped' | 'missing';
  outputs?: Record<string, unknown>[];
  error?: string;
}

export class TaskRunner {
  constructor(private readonly deps: TaskRunnerDeps) {}

  async run(taskId: string, opts?: { resume?: ResumeHint }): Promise<RunTaskResult> {
    const { db, redis, logger } = this.deps;

    // ① 跨租户定位任务（sched_scan 策略放行 SELECT，02 §4.3）
    const probe = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.sched', '1', true)`);
      const [row] = await tx
        .select({
          id: schema.aiTask.id,
          orgId: schema.aiTask.orgId,
          type: schema.aiTask.type,
          status: schema.aiTask.status,
          employeeId: schema.aiTask.employeeId,
          title: schema.aiTask.title,
          input: schema.aiTask.input,
          progressPct: schema.aiTask.progressPct,
          currentStep: schema.aiTask.currentStep,
        })
        .from(schema.aiTask)
        .where(eq(schema.aiTask.id, taskId))
        .limit(1);
      return row ?? null;
    });
    if (!probe) {
      logger.warn({ taskId }, '任务不存在（job 与 DB 不一致），跳过执行');
      return { status: 'missing' };
    }

    // ② 领取（乐观锁状态机）
    const claim = await this.claim(probe, opts?.resume);
    if (!claim.ok) {
      return { status: 'skipped' };
    }
    if (claim.transitioned) {
      await this.deps.publisher.publish(taskId, buildStatusEvent({ status: TASK_STATUS.RUNNING }));
    }

    // ③ 快照加载 → TaskRunContext
    const snapshot = await this.loadSnapshot(probe.orgId, probe.employeeId);
    const ctx: TaskRunContext = {
      orgId: probe.orgId,
      taskId,
      employeeId: snapshot.employee.id,
      nodeId: '',
      taskType: probe.type as TaskType,
      redis,
      logger,
      now: new Date(),
      bag: new Map(),
      events: [],
      db,
      employee: snapshot.employee,
      org: snapshot.org,
      task: { id: taskId, title: probe.title, input: probe.input ?? {} },
      progressPct: probe.progressPct,
      currentStep: probe.currentStep ?? '',
    };
    if (opts?.resume) {
      ctx.bag.set('resumeApproval', { ...opts.resume });
    }

    // ④ 心跳（ZombieReaper 依据 04 §5.4：30s 心跳 / 90s TTL）
    const stopHeartbeat = this.startHeartbeat(taskId);

    // ⑤ 图执行
    try {
      const { sop, stateKeys } = this.deps.sops.get(ctx.taskType);
      const graph = this.deps.compiler.compile(ctx.orgId, ctx.taskType, sop, stateKeys);
      const finalState = await graph.invoke(buildInitialState(ctx, stateKeys), ctx);
      const outputs = buildOutputs(finalState);
      await this.complete(taskId, probe.orgId, snapshot.employee.id, outputs);
      return { status: TASK_STATUS.COMPLETED, outputs };
    } catch (err) {
      if (err instanceof ApprovalPendingError) {
        // gate.enterWaiting 已落 waiting_approval/员工/跟进同步；此处仅 flush 挂起事件
        await redis.del(heartbeatKey(taskId));
        await flushBufferedEvents(this.deps.publisher, taskId, ctx.events);
        logger.info({ taskId, approvalId: err.approvalId }, '任务进入审批挂起，job 正常结束');
        return { status: TASK_STATUS.WAITING_APPROVAL };
      }
      const error = err instanceof Error ? err.message : String(err);
      await this.fail(taskId, probe.orgId, snapshot.employee.id, error);
      return { status: TASK_STATUS.FAILED, error };
    } finally {
      stopHeartbeat();
    }
  }

  // ===== 领取 =====

  /**
   * 乐观锁领取（04 §5.2）：
   * - 正常：scheduled → running（0 行命中 = 重复投递/已取消 → 跳过）；
   * - resume：waiting_approval → running（markResumed 已置 running 时幂等放行），
   *   并同步员工 working、follow_up_task scheduled（排期冻结解除）。
   */
  private async claim(
    probe: {
      id: string;
      orgId: string;
      employeeId: string;
      title: string;
      input: Record<string, unknown>;
    },
    resume?: ResumeHint,
  ): Promise<{ ok: boolean; transitioned: boolean }> {
    const now = new Date();
    return withOrg(this.deps.db, probe.orgId, async (tx) => {
      if (resume) {
        const rows = await tx
          .update(schema.aiTask)
          .set({
            status: TASK_STATUS.RUNNING,
            startedAt: sql`coalesce(${schema.aiTask.startedAt}, ${now})`,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.aiTask.id, probe.id),
              eq(schema.aiTask.status, TASK_STATUS.WAITING_APPROVAL),
            ),
          )
          .returning({ id: schema.aiTask.id });
        if (rows.length === 0) {
          const [row] = await tx
            .select({ status: schema.aiTask.status })
            .from(schema.aiTask)
            .where(eq(schema.aiTask.id, probe.id))
            .limit(1);
          if (row?.status === TASK_STATUS.RUNNING) {
            return { ok: true, transitioned: false }; // API 已 markResumed，幂等续跑
          }
          this.deps.logger.warn(
            { taskId: probe.id, status: row?.status },
            'resume 领取未命中，任务已非续跑态',
          );
          return { ok: false, transitioned: false };
        }
        await this.syncResumeSides(tx, probe);
        return { ok: true, transitioned: true };
      }

      const rows = await tx
        .update(schema.aiTask)
        .set({ status: TASK_STATUS.RUNNING, startedAt: now, updatedAt: now })
        .where(and(eq(schema.aiTask.id, probe.id), eq(schema.aiTask.status, TASK_STATUS.SCHEDULED)))
        .returning({ id: schema.aiTask.id });
      if (rows.length === 0) {
        const [row] = await tx
          .select({ status: schema.aiTask.status })
          .from(schema.aiTask)
          .where(eq(schema.aiTask.id, probe.id))
          .limit(1);
        this.deps.logger.warn(
          { taskId: probe.id, status: row?.status },
          '领取未命中（重复投递或任务已离开 scheduled），跳过执行',
        );
        return { ok: false, transitioned: false };
      }
      await tx
        .update(schema.aiEmployee)
        .set({ status: EMPLOYEE_STATUS.WORKING, statusDetail: probe.title, updatedAt: now })
        .where(eq(schema.aiEmployee.id, probe.employeeId));
      return { ok: true, transitioned: true };
    });
  }

  /** resume 伴生状态：员工 working + follow_up_task scheduled（04 §7 / Runtime §4.7） */
  private async syncResumeSides(
    tx: Parameters<Parameters<Db['transaction']>[0]>[0],
    probe: { employeeId: string; input: Record<string, unknown> },
  ): Promise<void> {
    const now = new Date();
    await tx
      .update(schema.aiEmployee)
      .set({ status: EMPLOYEE_STATUS.WORKING, updatedAt: now })
      .where(
        and(
          eq(schema.aiEmployee.id, probe.employeeId),
          eq(schema.aiEmployee.status, EMPLOYEE_STATUS.WAITING_APPROVAL),
        ),
      );
    const followUpTaskId = probe.input['followUpTaskId'];
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
  }

  // ===== 快照 =====

  private async loadSnapshot(
    orgId: string,
    employeeId: string,
  ): Promise<{ employee: EmployeeRuntime; org: OrgRuntime }> {
    return withOrg(this.deps.db, orgId, async (tx) => {
      const [emp] = await tx
        .select()
        .from(schema.aiEmployee)
        .where(eq(schema.aiEmployee.id, employeeId))
        .limit(1);
      if (!emp) {
        throw new BizException(40404 as never, `AI 员工不存在: ${employeeId}`);
      }
      const [orgRow] = await tx
        .select({
          id: schema.org.id,
          timezone: schema.org.timezone,
          sendRules: schema.org.sendRules,
        })
        .from(schema.org)
        .where(eq(schema.org.id, orgId))
        .limit(1);
      if (!orgRow) {
        throw new BizException(ErrorCode.NOT_FOUND, `企业不存在: ${orgId}`);
      }
      const perms = await tx
        .select({
          role: schema.rolePermission.role,
          approvalRules: schema.rolePermission.approvalRules,
        })
        .from(schema.rolePermission)
        .where(eq(schema.rolePermission.orgId, orgId));
      // 员工角色与用户角色域不同（ai_employee_role ⊅ user_role）：仅同名角色（sales/manager）命中审批规则
      const rules = (perms.find((p) => p.role === emp.role)?.approvalRules ??
        []) as OrgApprovalRule[];
      // M3-14：按类型审批超时（expireHours 小时 → 毫秒；非法值忽略回落 gate 侧 48h 常量）
      const approvalTtlMsByType: Record<string, number> = {};
      for (const rule of rules) {
        if (typeof rule.expireHours === 'number' && rule.expireHours > 0) {
          approvalTtlMsByType[rule.approvalType] = rule.expireHours * 3600 * 1000;
        }
      }

      const employee: EmployeeRuntime = {
        id: emp.id,
        orgId: emp.orgId,
        role: emp.role,
        name: emp.name,
        tools: emp.tools,
        knowledgeScope: emp.knowledgeScope,
        approvalPolicy: emp.approvalPolicy,
        memoryConfig: emp.memoryConfig ?? null,
        externalCallDailyLimit:
          typeof emp.permissions['externalCallDailyLimit'] === 'number'
            ? emp.permissions['externalCallDailyLimit']
            : DEFAULT_EXTERNAL_CALL_LIMIT,
      };
      const org: OrgRuntime = {
        id: orgRow.id,
        timezone: orgRow.timezone ?? 'Asia/Shanghai',
        sendRules: orgRow.sendRules ?? null,
        autoApproveTypes: rules.filter((r) => r.autoApprove === true).map((r) => r.approvalType),
        approvalTtlMsByType,
      };
      return { employee, org };
    });
  }

  // ===== 终态 =====

  private async complete(
    taskId: string,
    orgId: string,
    employeeId: string,
    outputs: Record<string, unknown>[],
  ): Promise<void> {
    const now = new Date();
    await withOrg(this.deps.db, orgId, async (tx) => {
      await tx
        .update(schema.aiTask)
        .set({
          status: TASK_STATUS.COMPLETED,
          outputs,
          progressPct: 100,
          finishedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.aiTask.id, taskId));
      // M3-06：终态回写前置校验——员工仍持有其它 active 任务则保持状态（防并发覆盖）
      const released = await releaseEmployeeIdle(tx, { employeeId, excludeTaskId: taskId, now });
      if (!released) {
        this.deps.logger.warn(
          { taskId, employeeId },
          '任务完成但员工仍占用其它任务，保持员工状态（终态回写前置校验）',
        );
      }
    });
    await this.deps.redis.del(heartbeatKey(taskId));
    await this.deps.publisher.publish(
      taskId,
      buildDoneEvent({ status: TASK_STATUS.COMPLETED, outputs }),
    );
    this.deps.logger.info({ taskId }, '任务完成');
  }

  private async fail(
    taskId: string,
    orgId: string,
    employeeId: string,
    error: string,
  ): Promise<void> {
    const now = new Date();
    await withOrg(this.deps.db, orgId, async (tx) => {
      await tx
        .update(schema.aiTask)
        .set({ status: TASK_STATUS.FAILED, error, finishedAt: now, updatedAt: now })
        .where(eq(schema.aiTask.id, taskId));
      // M3-06：同 complete，终态回写前置校验
      const released = await releaseEmployeeIdle(tx, { employeeId, excludeTaskId: taskId, now });
      if (!released) {
        this.deps.logger.warn(
          { taskId, employeeId },
          '任务失败但员工仍占用其它任务，保持员工状态（终态回写前置校验）',
        );
      }
    });
    await this.deps.redis.del(heartbeatKey(taskId));
    await this.deps.publisher.publish(
      taskId,
      buildStatusEvent({ status: TASK_STATUS.FAILED, error }),
    );
    await this.deps.publisher.publish(
      taskId,
      buildDoneEvent({ status: TASK_STATUS.FAILED, outputs: [], error }),
    );
    this.deps.logger.warn({ taskId, error }, '任务失败');
  }

  // ===== 心跳 =====

  private startHeartbeat(taskId: string): () => void {
    const { redis } = this.deps;
    const key = heartbeatKey(taskId);
    const beat = (): void => {
      void redis.set(key, String(process.pid), 'EX', HEARTBEAT_TTL_S).catch(() => undefined);
    };
    beat();
    const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}

/** 心跳 key（ZombieReaper 同源，04 §5.4：30s 心跳 / 90s TTL） */
export function heartbeatKey(taskId: string): string {
  return `task:${taskId}:heartbeat`;
}

/** 初始 State：BaseTaskState 恒定键 + input 同名键播种（LastValue 通道未写键在节点侧读为 undefined） */
function buildInitialState(
  ctx: TaskRunContext,
  stateKeys: readonly string[],
): Record<string, unknown> {
  const initial: Record<string, unknown> = {
    taskId: ctx.taskId,
    orgId: ctx.orgId,
    employeeId: ctx.employeeId,
    taskType: ctx.taskType,
    input: ctx.task.input,
    errors: [],
  };
  for (const key of stateKeys) {
    if (key in initial || key === BRANCH_KEY) {
      continue;
    }
    const value = ctx.task.input[key];
    if (value !== undefined) {
      initial[key] = value;
    }
  }
  return initial;
}

/** 终态 outputs 摘取：剥离运行时键，其余 State 产出包进单条 result（14 outputs jsonb 数组契约） */
function buildOutputs(finalState: Record<string, unknown>): Record<string, unknown>[] {
  const reserved = new Set([
    'taskId',
    'orgId',
    'employeeId',
    'taskType',
    'input',
    'errors',
    BRANCH_KEY,
  ]);
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(finalState)) {
    if (reserved.has(key) || value === undefined || value === null) {
      continue;
    }
    data[key] = value;
  }
  return [{ type: 'result', data }];
}
