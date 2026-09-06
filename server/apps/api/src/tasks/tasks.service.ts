import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { BizException, createId } from '@tradepilot/core';
import { schema, withOrg, type Db } from '@tradepilot/db';
import { TaskEnqueuer } from '@tradepilot/runtime';
import type { TaskType } from '@tradepilot/shared';
import { DB } from '../db/db.module.js';
import { REDIS } from '../redis/redis.module.js';
import { EnvService } from '../config/env.service.js';
import type { CreateTaskDto, ListTasksQuery } from './tasks.dto.js';

/**
 * 任务中心服务（接口 14 §3 / 技术方案 04 §2）：
 * - 入队判定：员工无 running 任务且 org running < 10 → running 直投；否则 scheduled 落库由 Dispatcher 启动；
 * - retry = 新任务（retry_of 溯源，输入复制），日志不迁移（14 §3.5）；
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
export class TasksService {
  private readonly enqueuer: TaskEnqueuer;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    env: EnvService,
  ) {
    this.enqueuer = new TaskEnqueuer(env.env.REDIS_URL);
  }

  /** 14 §3.2 通用新建（+ 入队判定 04 §2）；retryOf 为 retry 内部溯源参数 */
  async create(
    orgId: string,
    userId: string,
    dto: CreateTaskDto,
    retryOf?: string,
  ): Promise<{ taskId: string; status: 'running' | 'scheduled' }> {
    return withOrg(this.db, orgId, async (tx) => {
      const [employee] = await tx
        .select({ id: schema.aiEmployee.id, status: schema.aiEmployee.status })
        .from(schema.aiEmployee)
        .where(and(eq(schema.aiEmployee.id, dto.employeeId), eq(schema.aiEmployee.orgId, orgId)))
        .limit(1);
      if (!employee) {
        throw BizException.notFound(`AI 员工不存在: ${dto.employeeId}`);
      }

      // 入队判定：员工 running=0 且 org running<10 → 直投；否则排队
      const [empRunning] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.aiTask)
        .where(
          and(
            eq(schema.aiTask.employeeId, dto.employeeId),
            eq(schema.aiTask.status, 'running'),
          ),
        );
      const [orgRunning] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.aiTask)
        .where(and(eq(schema.aiTask.orgId, orgId), eq(schema.aiTask.status, 'running')));
      const canRun = (empRunning?.n ?? 0) === 0 && (orgRunning?.n ?? 0) < ORG_CONCURRENCY_LIMIT;
      const status = canRun ? 'running' : 'scheduled';

      const taskId = createId('task');
      await tx.insert(schema.aiTask).values({
        id: taskId,
        orgId,
        employeeId: dto.employeeId,
        type: dto.type,
        title: dto.title,
        status,
        input: dto.input,
        scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
        createdBy: userId,
      });
      if (canRun) {
        await this.enqueuer.enqueueTask(taskId, dto.type as TaskType);
      }
      return { taskId, status };
    });
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
}
