import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { BizException, createId } from '@tradepilot/core';
import { schema, withOrg, type Db } from '@tradepilot/db';
import {
  TaskEnqueuer,
  TaskEventPublisher,
  buildDoneEvent,
  buildStatusEvent,
  releaseEmployeeIdle,
} from '@tradepilot/runtime';
import {
  EMPLOYEE_OCCUPYING_TASK_STATUSES,
  EMPLOYEE_STATUS,
  TASK_STATUS,
  type TaskStatus,
  type TaskType,
} from '@tradepilot/shared';
import { DB } from '../db/db.module.js';
import { REDIS } from '../redis/redis.module.js';
import { EnvService } from '../config/env.service.js';
import type {
  BatchTaskActionDto,
  CreateTaskDto,
  ListTasksQuery,
  TransferToHumanDto,
} from './tasks.dto.js';

/**
 * 任务中心服务（接口 14 §3 / 技术方案 04 §2）：
 * - 落库语义：一律 scheduled；running 由 Runner.claim 独占置位并补 started_at（04 §5.2），
 *   杜绝「running + started_at 空」的不可恢复直投态（M3-01 冻结 org 并发根因）；
 * - 入队判定：员工无占用任务（running/waiting_approval，M3-06 挂起占员工位）且 org running < 10
 *   且非未来定时 → 事务提交后即时入队（响应 status='running' 表示已投递待执行）；否则 scheduled
 *   排队由 Dispatcher 按序启动；
 * - retry = 新任务（retry_of 溯源，输入复制），日志不迁移（14 §3.5）；
 * - 操作类（P1-X-30~33）：pause/resume/cancel/transfer-to-human 一律「事务内状态机写库 + 员工位联动
 *   + 事务提交后 delayed job 清理/重新入队 + SSE status/done 推送」；批量处理复用单任务语义。
 * - 列表/详情/日志增量/步骤均为只读聚合（员工卡片轻量对象另在 02 接口）。
 */

/** org 总并发 MVP 内置常量（04 §3.3） */
const ORG_CONCURRENCY_LIMIT = 10;

export interface TaskListItem {
  taskId: string;
  title: string;
  type: string;
  status: string;
  progressPct: number;
  currentStep: string | null;
  employeeId: string;
  employeeName: string;
  role: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  linkedApprovalId: string | null;
}

@Injectable()
export class TasksService implements OnModuleDestroy {
  private readonly enqueuer: TaskEnqueuer;
  private readonly publisher: TaskEventPublisher;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    // 无装饰参数依赖 design:paramtypes 元数据：import type 会擦除类引用导致 Nest 无法解析
    @Inject(EnvService) env: EnvService,
  ) {
    this.enqueuer = new TaskEnqueuer(env.env.REDIS_URL);
    this.publisher = new TaskEventPublisher(redis);
  }

  /** Nest 生命周期：关闭 BullMQ 队列连接（应用退出/模块销毁时释放） */
  async onModuleDestroy(): Promise<void> {
    await this.enqueuer.close();
  }

  /** 14 §3.2 通用新建（+ 入队判定 04 §2）；retryOf 为 retry 内部溯源参数 */
  async create(
    orgId: string,
    userId: string,
    dto: CreateTaskDto,
    retryOf?: string,
  ): Promise<{ taskId: string; status: 'running' | 'scheduled' }> {
    // 事务只落库 scheduled（running 由 Runner.claim 独占置位并补 started_at，04 §5.2）。
    // 直投判定在事务内只读并发快照，入队放到提交之后（Worker probe 必须读到已提交行）。
    const { taskId, immediate } = await withOrg(this.db, orgId, async (tx) => {
      const [employee] = await tx
        .select({ id: schema.aiEmployee.id, status: schema.aiEmployee.status })
        .from(schema.aiEmployee)
        .where(and(eq(schema.aiEmployee.id, dto.employeeId), eq(schema.aiEmployee.orgId, orgId)))
        .limit(1);
      if (!employee) {
        throw BizException.notFound(`AI 员工不存在: ${dto.employeeId}`);
      }

      // 入队判定：员工无占用任务（running/waiting_approval，M3-06 挂起占员工位）且 org running<10 → 直投；否则排队
      const [empBusy] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.aiTask)
        .where(
          and(
            eq(schema.aiTask.employeeId, dto.employeeId),
            inArray(schema.aiTask.status, [...EMPLOYEE_OCCUPYING_TASK_STATUSES]),
          ),
        );
      const [orgRunning] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.aiTask)
        .where(and(eq(schema.aiTask.orgId, orgId), eq(schema.aiTask.status, 'running')));
      const canRun = (empBusy?.n ?? 0) === 0 && (orgRunning?.n ?? 0) < ORG_CONCURRENCY_LIMIT;
      // 未来定时任务不得直投：即使并发空闲也保持 scheduled，由 Dispatcher 到点投递（04 §3.4）
      const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : null;
      const due = !scheduledAt || scheduledAt.getTime() <= Date.now();
      const immediate = canRun && due;

      const taskId = createId('task');
      await tx.insert(schema.aiTask).values({
        id: taskId,
        orgId,
        employeeId: dto.employeeId,
        type: dto.type,
        title: dto.title,
        status: 'scheduled',
        input: dto.input,
        scheduledAt,
        retryOf,
        createdBy: userId,
      });
      return { taskId, immediate };
    });

    // 事务提交后再入队：若在事务内入队，Worker 可能先于提交消费 → probe 落空 → 任务永久卡死（M3-01）
    if (immediate) {
      await this.enqueuer.enqueueTask(taskId, dto.type as TaskType);
    }
    // status 语义（14 §3.2）：'running' = 已即时投递待执行；'scheduled' = 排队/定时，由 Dispatcher 启动
    return { taskId, status: immediate ? 'running' : 'scheduled' };
  }

  /** 14 §3.1 任务列表（status Tab / employeeId / type / keyword / 分页） */
  async list(
    orgId: string,
    query: ListTasksQuery & { page: number; pageSize: number; keyword?: string },
  ): Promise<{ items: TaskListItem[]; total: number; page: number; pageSize: number }> {
    return withOrg(this.db, orgId, async (tx) => {
      const conditions = [eq(schema.aiTask.orgId, orgId)];
      if (query.status) {
        conditions.push(eq(schema.aiTask.status, query.status));
      }
      if (query.employeeId) {
        conditions.push(eq(schema.aiTask.employeeId, query.employeeId));
      }
      if (query.type) {
        conditions.push(eq(schema.aiTask.type, query.type));
      }
      if (query.keyword) {
        conditions.push(ilike(schema.aiTask.title, `%${query.keyword}%`));
      }
      const where = and(...conditions);
      const rows = await tx
        .select({
          id: schema.aiTask.id,
          title: schema.aiTask.title,
          type: schema.aiTask.type,
          status: schema.aiTask.status,
          progressPct: schema.aiTask.progressPct,
          currentStep: schema.aiTask.currentStep,
          employeeId: schema.aiTask.employeeId,
          employeeName: schema.aiEmployee.name,
          role: schema.aiEmployee.role,
          createdAt: schema.aiTask.createdAt,
          startedAt: schema.aiTask.startedAt,
          finishedAt: schema.aiTask.finishedAt,
          error: schema.aiTask.error,
          linkedApprovalId: schema.aiTask.linkedApprovalId,
        })
        .from(schema.aiTask)
        .innerJoin(schema.aiEmployee, eq(schema.aiEmployee.id, schema.aiTask.employeeId))
        .where(where)
        .orderBy(desc(schema.aiTask.createdAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);
      const [total] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.aiTask)
        .where(where);
      return {
        items: rows.map((r) => ({
          taskId: r.id,
          title: r.title,
          type: r.type,
          status: r.status,
          progressPct: r.progressPct,
          currentStep: r.currentStep,
          employeeId: r.employeeId,
          employeeName: r.employeeName,
          role: r.role,
          createdAt: r.createdAt.toISOString(),
          startedAt: r.startedAt?.toISOString() ?? null,
          finishedAt: r.finishedAt?.toISOString() ?? null,
          error: r.error,
          linkedApprovalId: r.linkedApprovalId,
        })),
        total: total?.n ?? 0,
        page: query.page,
        pageSize: query.pageSize,
      };
    });
  }

  /** 14 §1.2 任务详情（input/steps/outputs + 列表行字段 + 关联审批） */
  async detail(orgId: string, taskId: string) {
    return withOrg(this.db, orgId, async (tx) => {
      const [task] = await tx
        .select({
          id: schema.aiTask.id,
          title: schema.aiTask.title,
          type: schema.aiTask.type,
          status: schema.aiTask.status,
          progressPct: schema.aiTask.progressPct,
          currentStep: schema.aiTask.currentStep,
          input: schema.aiTask.input,
          outputs: schema.aiTask.outputs,
          error: schema.aiTask.error,
          linkedApprovalId: schema.aiTask.linkedApprovalId,
          retryOf: schema.aiTask.retryOf,
          employeeId: schema.aiTask.employeeId,
          employeeName: schema.aiEmployee.name,
          role: schema.aiEmployee.role,
          createdAt: schema.aiTask.createdAt,
          startedAt: schema.aiTask.startedAt,
          finishedAt: schema.aiTask.finishedAt,
        })
        .from(schema.aiTask)
        .innerJoin(schema.aiEmployee, eq(schema.aiEmployee.id, schema.aiTask.employeeId))
        .where(and(eq(schema.aiTask.id, taskId), eq(schema.aiTask.orgId, orgId)))
        .limit(1);
      if (!task) {
        throw BizException.notFound(`任务不存在: ${taskId}`);
      }
      const steps = await tx
        .select({
          name: schema.aiTaskStep.name,
          status: schema.aiTaskStep.status,
          seq: schema.aiTaskStep.seq,
          startedAt: schema.aiTaskStep.startedAt,
          finishedAt: schema.aiTaskStep.finishedAt,
        })
        .from(schema.aiTaskStep)
        .where(eq(schema.aiTaskStep.taskId, taskId))
        .orderBy(asc(schema.aiTaskStep.seq));
      return {
        taskId: task.id,
        title: task.title,
        type: task.type,
        status: task.status,
        progressPct: task.progressPct,
        currentStep: task.currentStep,
        input: task.input,
        outputs: task.outputs ?? [],
        steps: steps.map((s) => ({
          seq: s.seq,
          name: s.name,
          status: s.status,
          startedAt: s.startedAt?.toISOString() ?? null,
          finishedAt: s.finishedAt?.toISOString() ?? null,
        })),
        error: task.error,
        linkedApprovalId: task.linkedApprovalId,
        retryOf: task.retryOf,
        employeeId: task.employeeId,
        employeeName: task.employeeName,
        role: task.role,
        createdAt: task.createdAt.toISOString(),
        startedAt: task.startedAt?.toISOString() ?? null,
        finishedAt: task.finishedAt?.toISOString() ?? null,
      };
    });
  }

  /** 14 §3.3 日志增量（after={logId} 雪花游标；occurredAt 兜底序） */
  async logs(orgId: string, taskId: string, after?: string, limit = 50) {
    return withOrg(this.db, orgId, async (tx) => {
      const [task] = await tx
        .select({ id: schema.aiTask.id })
        .from(schema.aiTask)
        .where(and(eq(schema.aiTask.id, taskId), eq(schema.aiTask.orgId, orgId)))
        .limit(1);
      if (!task) {
        throw BizException.notFound(`任务不存在: ${taskId}`);
      }
      const conditions = [eq(schema.aiTaskLog.taskId, taskId)];
      if (after) {
        // Crockford 字典序 = 时间序（雪花游标 02 §8.3）
        conditions.push(sql`${schema.aiTaskLog.id} > ${after}`);
      }
      const rows = await tx
        .select({
          id: schema.aiTaskLog.id,
          occurredAt: schema.aiTaskLog.occurredAt,
          type: schema.aiTaskLog.type,
          content: schema.aiTaskLog.content,
          leadId: schema.aiTaskLog.leadId,
        })
        .from(schema.aiTaskLog)
        .where(and(...conditions))
        .orderBy(asc(schema.aiTaskLog.id))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map((r) => ({
        logId: r.id,
        time: r.occurredAt.toISOString(),
        type: r.type,
        content: r.content,
        ...(r.leadId ? { leadId: r.leadId } : {}),
      }));
      return { items, hasMore };
    });
  }

  /** 14 §3.5 失败重试 = 新任务（retry_of 溯源；输入复制） */
  async retry(orgId: string, userId: string, taskId: string) {
    const source = await withOrg(this.db, orgId, async (tx) => {
      const [task] = await tx
        .select({
          id: schema.aiTask.id,
          employeeId: schema.aiTask.employeeId,
          type: schema.aiTask.type,
          title: schema.aiTask.title,
          input: schema.aiTask.input,
          status: schema.aiTask.status,
        })
        .from(schema.aiTask)
        .where(and(eq(schema.aiTask.id, taskId), eq(schema.aiTask.orgId, orgId)))
        .limit(1);
      return task ?? null;
    });
    if (!source) {
      throw BizException.notFound(`任务不存在: ${taskId}`);
    }
    if (source.status !== 'failed') {
      throw BizException.conflict('仅失败任务可重试（14 §3.5）');
    }
    return this.create(
      orgId,
      userId,
      {
        employeeId: source.employeeId,
        type: source.type as CreateTaskDto['type'],
        title: source.title,
        input: source.input,
      },
      source.id,
    );
  }

  // ===== 任务中心操作（P1-X-30~33，04 §5.4 / 14 §3.6~3.7） =====

  /**
   * 14 §3.6 暂停（P1-X-30）：running/scheduled → paused。
   * paused 不占并发 → 释放员工位；执行中任务在下个节点探测到离开 running 后中止（PauseAbortError），
   * checkpointer 保留检查点；事务提交后清理 delayed job（removeTask）并推 SSE status=paused。
   */
  async pause(orgId: string, taskId: string): Promise<{ taskId: string; status: TaskStatus }> {
    const result = await withOrg(this.db, orgId, async (tx) => {
      const [task] = await tx
        .select({
          id: schema.aiTask.id,
          type: schema.aiTask.type,
          status: schema.aiTask.status,
          employeeId: schema.aiTask.employeeId,
        })
        .from(schema.aiTask)
        .where(and(eq(schema.aiTask.id, taskId), eq(schema.aiTask.orgId, orgId)))
        .limit(1);
      if (!task) {
        throw BizException.notFound(`任务不存在: ${taskId}`);
      }
      if (task.status === TASK_STATUS.PAUSED) {
        return { type: task.type as TaskType, changed: false }; // 幂等：已暂停直接返回
      }
      if (task.status !== TASK_STATUS.RUNNING && task.status !== TASK_STATUS.SCHEDULED) {
        throw BizException.conflict('仅执行中/已排期任务可暂停（14 §3.6）');
      }
      const now = new Date();
      const rows = await tx
        .update(schema.aiTask)
        .set({ status: TASK_STATUS.PAUSED, updatedAt: now })
        .where(
          and(
            eq(schema.aiTask.id, taskId),
            inArray(schema.aiTask.status, [TASK_STATUS.RUNNING, TASK_STATUS.SCHEDULED]),
          ),
        )
        .returning({ id: schema.aiTask.id });
      if (rows.length === 0) {
        throw BizException.conflict('任务状态已变更，请刷新后重试');
      }
      await tx.insert(schema.aiTaskLog).values({
        id: createId('tlog'),
        orgId,
        taskId,
        occurredAt: now,
        type: 'error',
        content: '任务已暂停（恢复后从最近检查点续跑当前节点）',
        leadId: null,
      });
      await releaseEmployeeIdle(tx, { employeeId: task.employeeId, excludeTaskId: taskId, now });
      return { type: task.type as TaskType, changed: true };
    });
    if (result.changed) {
      await this.enqueuer.removeTask(taskId, result.type);
      await this.publisher.publish(taskId, buildStatusEvent({ status: TASK_STATUS.PAUSED }));
    }
    return { taskId, status: TASK_STATUS.PAUSED };
  }

  /**
   * 14 §3.6 恢复（P1-X-30 / 04 §5.4）：paused → 续跑。
   * - 已产生检查点（started_at 非空）：paused → running + 员工 working，事务提交后按 jobId 重投并携带
   *   fromPause（Runner invoke(null) 从最近检查点续跑当前节点，工具按 taskId+nodeId 幂等防重复）；
   * - 从未执行（暂停于 scheduled）：paused → scheduled，由 Dispatcher 全新投递。
   */
  async resume(
    orgId: string,
    taskId: string,
  ): Promise<{ taskId: string; status: TaskStatus; fromCheckpoint: boolean }> {
    const result = await withOrg(this.db, orgId, async (tx) => {
      const [task] = await tx
        .select({
          id: schema.aiTask.id,
          type: schema.aiTask.type,
          status: schema.aiTask.status,
          title: schema.aiTask.title,
          employeeId: schema.aiTask.employeeId,
          startedAt: schema.aiTask.startedAt,
        })
        .from(schema.aiTask)
        .where(and(eq(schema.aiTask.id, taskId), eq(schema.aiTask.orgId, orgId)))
        .limit(1);
      if (!task) {
        throw BizException.notFound(`任务不存在: ${taskId}`);
      }
      if (task.status !== TASK_STATUS.PAUSED) {
        throw BizException.conflict('仅已暂停任务可恢复（14 §3.6）');
      }
      const now = new Date();
      const fromCheckpoint = task.startedAt !== null;
      const nextStatus: TaskStatus = fromCheckpoint ? TASK_STATUS.RUNNING : TASK_STATUS.SCHEDULED;
      const rows = fromCheckpoint
        ? await tx
            .update(schema.aiTask)
            .set({
              status: TASK_STATUS.RUNNING,
              startedAt: sql`coalesce(${schema.aiTask.startedAt}, ${now})`,
              updatedAt: now,
            })
            .where(and(eq(schema.aiTask.id, taskId), eq(schema.aiTask.status, TASK_STATUS.PAUSED)))
            .returning({ id: schema.aiTask.id })
        : await tx
            .update(schema.aiTask)
            .set({ status: TASK_STATUS.SCHEDULED, updatedAt: now })
            .where(and(eq(schema.aiTask.id, taskId), eq(schema.aiTask.status, TASK_STATUS.PAUSED)))
            .returning({ id: schema.aiTask.id });
      if (rows.length === 0) {
        throw BizException.conflict('任务状态已变更，请刷新后重试');
      }
      if (fromCheckpoint) {
        // 对齐审批 resume 伴生状态：员工回 working（Runner 领取时再幂等确认）
        await tx
          .update(schema.aiEmployee)
          .set({ status: EMPLOYEE_STATUS.WORKING, statusDetail: task.title, updatedAt: now })
          .where(eq(schema.aiEmployee.id, task.employeeId));
      }
      await tx.insert(schema.aiTaskLog).values({
        id: createId('tlog'),
        orgId,
        taskId,
        occurredAt: now,
        type: 'error',
        content: fromCheckpoint ? '任务已恢复（从最近检查点续跑）' : '任务已恢复（重新排队执行）',
        leadId: null,
      });
      return { type: task.type as TaskType, fromCheckpoint, status: nextStatus };
    });
    if (result.fromCheckpoint) {
      await this.enqueuer.enqueueResumeFromPause(taskId, result.type);
      await this.publisher.publish(taskId, buildStatusEvent({ status: TASK_STATUS.RUNNING }));
    }
    return { taskId, status: result.status, fromCheckpoint: result.fromCheckpoint };
  }

  /**
   * 14 §3.6 取消（P1-X-30 / 04 §5.4）：running/scheduled/paused → canceled（终态）。
   * 释放员工位 → 清理 delayed job → 推 SSE status + done（收口流）。
   * waiting_approval 由审核中心处置，不在取消范围（避免审批单悬挂）。
   */
  async cancel(
    orgId: string,
    taskId: string,
  ): Promise<{ taskId: string; status: TaskStatus; outputs: Record<string, unknown>[] }> {
    const result = await withOrg(this.db, orgId, async (tx) => {
      const [task] = await tx
        .select({
          id: schema.aiTask.id,
          type: schema.aiTask.type,
          status: schema.aiTask.status,
          employeeId: schema.aiTask.employeeId,
          outputs: schema.aiTask.outputs,
        })
        .from(schema.aiTask)
        .where(and(eq(schema.aiTask.id, taskId), eq(schema.aiTask.orgId, orgId)))
        .limit(1);
      if (!task) {
        throw BizException.notFound(`任务不存在: ${taskId}`);
      }
      const outputs = (task.outputs ?? []) as Record<string, unknown>[];
      if (task.status === TASK_STATUS.CANCELED) {
        return { type: task.type as TaskType, changed: false, outputs }; // 幂等
      }
      const isCancellable =
        task.status === TASK_STATUS.RUNNING ||
        task.status === TASK_STATUS.SCHEDULED ||
        task.status === TASK_STATUS.PAUSED;
      if (!isCancellable) {
        throw BizException.conflict('仅执行中/已排队/已暂停任务可取消（14 §3.6）');
      }
      const now = new Date();
      const rows = await tx
        .update(schema.aiTask)
        .set({ status: TASK_STATUS.CANCELED, finishedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.aiTask.id, taskId),
            inArray(schema.aiTask.status, [
              TASK_STATUS.RUNNING,
              TASK_STATUS.SCHEDULED,
              TASK_STATUS.PAUSED,
            ]),
          ),
        )
        .returning({ id: schema.aiTask.id });
      if (rows.length === 0) {
        throw BizException.conflict('任务状态已变更，请刷新后重试');
      }
      await tx.insert(schema.aiTaskLog).values({
        id: createId('tlog'),
        orgId,
        taskId,
        occurredAt: now,
        type: 'error',
        content: '任务已取消',
        leadId: null,
      });
      await releaseEmployeeIdle(tx, { employeeId: task.employeeId, excludeTaskId: taskId, now });
      return { type: task.type as TaskType, changed: true, outputs };
    });
    if (result.changed) {
      await this.enqueuer.removeTask(taskId, result.type);
      await this.publisher.publish(taskId, buildStatusEvent({ status: TASK_STATUS.CANCELED }));
      await this.publisher.publish(
        taskId,
        buildDoneEvent({ status: TASK_STATUS.CANCELED, outputs: result.outputs }),
      );
    }
    return { taskId, status: TASK_STATUS.CANCELED, outputs: result.outputs };
  }

  /**
   * 14 §3.6 转人工（P1-X-31 / 04 §5.4）：暂停图 + 写 outputs 交接摘要（type='handoff'）。
   * - running：置 paused（图在下个节点中止）+ 释放员工位 + 清理 delayed job + 推 SSE status=paused；
   * - paused：仅追加交接摘要（图已停）；
   * - failed：保持 failed，仅追加交接摘要（人工接管失败任务）。
   * 摘要 append 语义：outputs = [...既有, { type:'handoff', payload }]。
   */
  async transferToHuman(
    orgId: string,
    userId: string,
    taskId: string,
    dto: TransferToHumanDto,
  ): Promise<{ taskId: string; status: TaskStatus; handoff: Record<string, unknown> }> {
    const result = await withOrg(this.db, orgId, async (tx) => {
      const [task] = await tx
        .select({
          id: schema.aiTask.id,
          type: schema.aiTask.type,
          status: schema.aiTask.status,
          title: schema.aiTask.title,
          employeeId: schema.aiTask.employeeId,
          outputs: schema.aiTask.outputs,
        })
        .from(schema.aiTask)
        .where(and(eq(schema.aiTask.id, taskId), eq(schema.aiTask.orgId, orgId)))
        .limit(1);
      if (!task) {
        throw BizException.notFound(`任务不存在: ${taskId}`);
      }
      const isTransferable =
        task.status === TASK_STATUS.RUNNING ||
        task.status === TASK_STATUS.PAUSED ||
        task.status === TASK_STATUS.FAILED;
      if (!isTransferable) {
        throw BizException.conflict('仅执行中/已暂停/失败任务可转人工（14 §3.6）');
      }
      const now = new Date();
      const wasRunning = task.status === TASK_STATUS.RUNNING;
      const nextStatus = (wasRunning ? TASK_STATUS.PAUSED : task.status) as TaskStatus;
      const handoff = {
        type: 'handoff',
        payload: {
          fromStatus: task.status,
          reason: dto.reason ?? null,
          summary:
            dto.summary ??
            `任务「${task.title}」转人工接管（原状态 ${task.status}），请人工继续跟进。`,
          assignee: dto.assignee ?? null,
          transferredAt: now.toISOString(),
          transferredBy: userId,
        },
      };
      const outputs = [...((task.outputs ?? []) as Record<string, unknown>[]), handoff];
      const rows = await tx
        .update(schema.aiTask)
        .set({ status: nextStatus, outputs, updatedAt: now })
        .where(
          and(
            eq(schema.aiTask.id, taskId),
            inArray(schema.aiTask.status, [
              TASK_STATUS.RUNNING,
              TASK_STATUS.PAUSED,
              TASK_STATUS.FAILED,
            ]),
          ),
        )
        .returning({ id: schema.aiTask.id });
      if (rows.length === 0) {
        throw BizException.conflict('任务状态已变更，请刷新后重试');
      }
      await tx.insert(schema.aiTaskLog).values({
        id: createId('tlog'),
        orgId,
        taskId,
        occurredAt: now,
        type: 'error',
        content: `任务转人工接管${dto.assignee ? `（承接：${dto.assignee}）` : ''}`,
        leadId: null,
      });
      if (wasRunning) {
        await releaseEmployeeIdle(tx, { employeeId: task.employeeId, excludeTaskId: taskId, now });
      }
      return { type: task.type as TaskType, status: nextStatus, wasRunning, handoff };
    });
    if (result.wasRunning) {
      await this.enqueuer.removeTask(taskId, result.type);
      await this.publisher.publish(taskId, buildStatusEvent({ status: TASK_STATUS.PAUSED }));
    }
    return { taskId, status: result.status, handoff: result.handoff };
  }

  /**
   * 14 §3.7 失败批量处理（P1-X-33）：多选重试 / 转人工（并发语义由 create 的排队判定保证）。
   * 逐条复用单任务语义；单条失败不阻断其余（结果逐条回传 ok/error）。
   */
  async batch(
    orgId: string,
    userId: string,
    dto: BatchTaskActionDto,
  ): Promise<{
    action: string;
    total: number;
    succeeded: number;
    failed: number;
    results: Array<{
      taskId: string;
      ok: boolean;
      status?: string;
      newTaskId?: string;
      error?: string;
    }>;
  }> {
    const results: Array<{
      taskId: string;
      ok: boolean;
      status?: string;
      newTaskId?: string;
      error?: string;
    }> = [];
    for (const taskId of dto.taskIds) {
      try {
        if (dto.action === 'retry') {
          const r = await this.retry(orgId, userId, taskId);
          results.push({ taskId, ok: true, status: r.status, newTaskId: r.taskId });
        } else {
          const r = await this.transferToHuman(orgId, userId, taskId, { reason: dto.reason });
          results.push({ taskId, ok: true, status: r.status });
        }
      } catch (err) {
        results.push({
          taskId,
          ok: false,
          error: err instanceof BizException ? err.message : String(err),
        });
      }
    }
    const succeeded = results.filter((r) => r.ok).length;
    return {
      action: dto.action,
      total: results.length,
      succeeded,
      failed: results.length - succeeded,
      results,
    };
  }
}
