/**
 * 07-AI 自动跟进服务（接口 07 §2/§3，M5-D1）：
 * - summary：总览统计（executingCount + all/today/waitingApproval/completed 四个 Tab 计数）；
 *   今天口径 = org.timezone（默认 Asia/Shanghai）当地日历日 == 今天的 nextRunAt；
 * - 任务列表（tab/keyword/分页）、pause、skip（顺延到策略下一步窗口，恒满足频控/窗口约束）；
 * - 策略 CRUD（默认策略禁改/禁删、被进行中任务引用禁删、steps 重建）、executions、apply。
 * 数据层遵循 withOrg RLS 事务注入；业务校验 42201 / 冲突 40901 / 越权 40301 统一 BizException。
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lt,
  notInArray,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  BizException,
  ErrorCode,
  computeDeferredNextRunAt,
  createId,
  getZonedWallTime,
  zonedWallTimeToUtc,
  type SendWindow,
} from '@tradepilot/core';
import {
  assertResourceAccess,
  notDeleted,
  schema,
  scopeAnd,
  withOrg,
  type Db,
  type OrgScopeContext,
  type Tx,
} from '@tradepilot/db';
import { DB } from '../db/db.module.js';
import type {
  ApplyStrategyDto,
  ListFollowUpTasksQuery,
  ListStrategiesQuery,
  StrategyStepDto,
  UpsertStrategyDto,
} from './follow-ups.dto.js';

/** 跟进任务总览统计（07 §3.1） */
export interface FollowUpSummary {
  executingCount: number;
  tabs: { all: number; today: number; waitingApproval: number; completed: number };
}

/** 跟进任务行（07 §1.2/§3.2；nextRunAt UTC 存储，展示按企业时区换算） */
export interface FollowUpTaskItem {
  followUpTaskId: string;
  customerId: string;
  companyName: string;
  currentStage: string;
  nextRunAt: string | null;
  status: string;
  strategyId: string;
  strategyName: string;
}

/** 执行记录行（07 §1.5/§3.4） */
export interface FollowUpExecution {
  executionId: string;
  followUpTaskId: string;
  stepTitle: string;
  sentAt: string | null;
  status: string;
  content?: string;
  approvedBy?: string;
  skipReason?: string;
}

/** 跟进阶段 → 步骤 seq 映射（follow_up_1 对应首步，07 §1.2/§2.1 设计说明 3） */
const STAGE_SEQ: Record<string, number> = {
  follow_up_1: 1,
  follow_up_2: 2,
  follow_up_3: 3,
  quote_followup: 4,
};

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

/** org 时区「今天」的 [当地 00:00, 次日 00:00) UTC 区间（07 §4 today 口径） */
function todayRange(timeZone: string): { start: Date; end: Date } {
  const wall = getZonedWallTime(new Date(), timeZone);
  const start = zonedWallTimeToUtc(
    { year: wall.year, month: wall.month, day: wall.day, hour: 0, minute: 0, second: 0 },
    timeZone,
  );
  const end = zonedWallTimeToUtc(
    { year: wall.year, month: wall.month, day: wall.day + 1, hour: 0, minute: 0, second: 0 },
    timeZone,
  );
  return { start, end };
}

/** PG 唯一约束冲突（23505）判定：dayOffset 重复兜底（uq_fstep_strategy_day） */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

@Injectable()
export class FollowUpsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 07 §3.1 总览统计：executingCount（非 completed/paused）+ 四 Tab 计数 */
  async summary(ctx: OrgScopeContext): Promise<FollowUpSummary> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const timeZone = await this.orgTimeZone(tx, ctx.orgId);
      const { start, end } = todayRange(timeZone);

      const rows = await tx
        .select({ status: schema.followUpTask.status, nextRunAt: schema.followUpTask.nextRunAt })
        .from(schema.followUpTask)
        .where(eq(schema.followUpTask.orgId, ctx.orgId));

      let all = 0;
      let today = 0;
      let waitingApproval = 0;
      let completed = 0;
      let executingCount = 0;
      for (const r of rows) {
        all += 1;
        if (r.status === 'completed') {
          completed += 1;
        }
        if (r.status === 'waiting_approval') {
          waitingApproval += 1;
        }
        if (r.status !== 'completed' && r.status !== 'paused') {
          executingCount += 1;
        }
        if (
          r.nextRunAt !== null &&
          r.nextRunAt.getTime() >= start.getTime() &&
          r.nextRunAt.getTime() < end.getTime()
        ) {
          today += 1;
        }
      }
      return { executingCount, tabs: { all, today, waitingApproval, completed } };
    });
  }

  /** 07 §3.2 跟进任务列表（tab/keyword/分页；关联 customer + strategy） */
  async listTasks(
    ctx: OrgScopeContext,
    query: ListFollowUpTasksQuery & { page: number; pageSize: number; keyword?: string },
  ): Promise<{ items: FollowUpTaskItem[]; total: number; page: number; pageSize: number }> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const timeZone = await this.orgTimeZone(tx, ctx.orgId);
      const { start, end } = todayRange(timeZone);

      const conditions: (SQL | undefined)[] = [
        eq(schema.followUpTask.orgId, ctx.orgId),
        notDeleted(schema.customer.deletedAt),
      ];
      if (query.tab === 'today') {
        conditions.push(and(gte(schema.followUpTask.nextRunAt, start), lt(schema.followUpTask.nextRunAt, end)));
      } else if (query.tab === 'waiting_approval') {
        conditions.push(eq(schema.followUpTask.status, 'waiting_approval'));
      } else if (query.tab === 'completed') {
        conditions.push(eq(schema.followUpTask.status, 'completed'));
      }
      if (query.keyword) {
        conditions.push(ilike(schema.customer.companyName, `%${query.keyword}%`));
      }
      const where = scopeAnd(...conditions);

      const rows = await tx
        .select({
          followUpTaskId: schema.followUpTask.id,
          customerId: schema.followUpTask.customerId,
          companyName: schema.customer.companyName,
          currentStage: schema.followUpTask.currentStage,
          nextRunAt: schema.followUpTask.nextRunAt,
          status: schema.followUpTask.status,
          strategyId: schema.followUpTask.strategyId,
          strategyName: schema.followUpStrategy.name,
        })
        .from(schema.followUpTask)
        .innerJoin(schema.customer, eq(schema.customer.id, schema.followUpTask.customerId))
        .innerJoin(schema.followUpStrategy, eq(schema.followUpStrategy.id, schema.followUpTask.strategyId))
        .where(where)
        .orderBy(desc(schema.followUpTask.createdAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);

      const [countRow] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.followUpTask)
        .innerJoin(schema.customer, eq(schema.customer.id, schema.followUpTask.customerId))
        .innerJoin(schema.followUpStrategy, eq(schema.followUpStrategy.id, schema.followUpTask.strategyId))
        .where(where);

      return {
        items: rows.map((r) => ({
          followUpTaskId: r.followUpTaskId,
          customerId: r.customerId,
          companyName: r.companyName,
          currentStage: r.currentStage,
          nextRunAt: r.nextRunAt?.toISOString() ?? null,
          status: r.status,
          strategyId: r.strategyId,
          strategyName: r.strategyName,
        })),
        total: countRow?.n ?? 0,
        page: query.page,
        pageSize: query.pageSize,
      };
    });
  }

  /** 07 §2 暂停单个客户跟进（如客户已回复）；completed → 40901 */
  async pause(ctx: OrgScopeContext, taskId: string): Promise<{ followUpTaskId: string; status: 'paused' }> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const [task] = await tx
        .select({ id: schema.followUpTask.id, status: schema.followUpTask.status })
        .from(schema.followUpTask)
        .where(and(eq(schema.followUpTask.id, taskId), eq(schema.followUpTask.orgId, ctx.orgId)))
        .limit(1);
      if (!task) {
        throw new BizException(ErrorCode.NOT_FOUND, '跟进任务不存在');
      }
      if (task.status === 'completed') {
        throw new BizException(ErrorCode.CONFLICT, '已完成的任务不可暂停');
      }
      if (task.status !== 'paused') {
        await tx
          .update(schema.followUpTask)
          .set({ status: 'paused', updatedAt: new Date() })
          .where(eq(schema.followUpTask.id, taskId));
      }
      return { followUpTaskId: taskId, status: 'paused' };
    });
  }

  /**
   * 07 §2 跳过下一步：把 nextRunAt 顺延到策略中比当前 stage 更靠后的第一个 step
   * （按 dayOffset 差值推进；无下一步则顺延 +24h 对齐 mock），最终经
   * computeDeferredNextRunAt 对齐发送窗口并满足频控约束；completed → 40901。
   */
  async skip(ctx: OrgScopeContext, taskId: string): Promise<{ followUpTaskId: string; nextRunAt: string }> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const [task] = await tx
        .select()
        .from(schema.followUpTask)
        .where(and(eq(schema.followUpTask.id, taskId), eq(schema.followUpTask.orgId, ctx.orgId)))
        .limit(1);
      if (!task) {
        throw new BizException(ErrorCode.NOT_FOUND, '跟进任务不存在');
      }
      if (task.status === 'completed') {
        throw new BizException(ErrorCode.CONFLICT, '已完成的任务不可跳过');
      }

      const steps = await tx
        .select({ seq: schema.followUpStrategyStep.seq, dayOffset: schema.followUpStrategyStep.dayOffset })
        .from(schema.followUpStrategyStep)
        .where(
          and(
            eq(schema.followUpStrategyStep.strategyId, task.strategyId),
            eq(schema.followUpStrategyStep.orgId, ctx.orgId),
          ),
        )
        .orderBy(asc(schema.followUpStrategyStep.seq));

      const currentSeq = STAGE_SEQ[task.currentStage] ?? 1;
      const currentStep = steps.find((s) => s.seq === currentSeq);
      const nextStep = steps.find((s) => s.seq > currentSeq);

      const now = new Date();
      const base = task.nextRunAt !== null && task.nextRunAt.getTime() > now.getTime() ? task.nextRunAt : now;
      const rawTarget = nextStep
        ? new Date(base.getTime() + Math.max(nextStep.dayOffset - (currentStep?.dayOffset ?? 0), 1) * 86_400_000)
        : new Date(base.getTime() + 24 * 3_600_000);

      const orgCtx = await this.orgSendContext(tx, ctx.orgId);
      const lastOutboundAt = await this.lastOutboundAt(tx, task.customerId);
      const nextRunAt = computeDeferredNextRunAt({
        now,
        nextRunAt: rawTarget,
        lastOutboundAt,
        minTouchIntervalDays: orgCtx.minTouchIntervalDays,
        timeZone: orgCtx.timeZone,
        ...(orgCtx.window ? { window: orgCtx.window } : {}),
      });

      await tx
        .update(schema.followUpTask)
        .set({ nextRunAt, updatedAt: now })
        .where(eq(schema.followUpTask.id, taskId));

      return { followUpTaskId: taskId, nextRunAt: nextRunAt.toISOString() };
    });
  }

  /** 07 §3.3 策略列表（含 steps 组装；strategy 行带 isDefault） */
  async listStrategies(
    ctx: OrgScopeContext,
    query: ListStrategiesQuery & { page: number; pageSize: number },
  ): Promise<{ items: FollowUpStrategy[]; total: number; page: number; pageSize: number }> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const conditions: SQL[] = [eq(schema.followUpStrategy.orgId, ctx.orgId)];
      if (query.keyword) {
        conditions.push(ilike(schema.followUpStrategy.name, `%${query.keyword}%`));
      }
      const where = and(...conditions);

      const rows = await tx
        .select()
        .from(schema.followUpStrategy)
        .where(where)
        .orderBy(desc(schema.followUpStrategy.createdAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);

      const [countRow] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.followUpStrategy)
        .where(where);

      const stepsByStrategy = new Map<string, typeof schema.followUpStrategyStep.$inferSelect[]>();
      if (rows.length > 0) {
        const stepRows = await tx
          .select()
          .from(schema.followUpStrategyStep)
          .where(
            and(
              eq(schema.followUpStrategyStep.orgId, ctx.orgId),
              inArray(
                schema.followUpStrategyStep.strategyId,
                rows.map((r) => r.id),
              ),
            ),
          )
          .orderBy(asc(schema.followUpStrategyStep.seq));
        for (const s of stepRows) {
          const arr = stepsByStrategy.get(s.strategyId) ?? [];
          arr.push(s);
          stepsByStrategy.set(s.strategyId, arr);
        }
      }

      return {
        items: rows.map((r) => ({
          strategyId: r.id,
          name: r.name,
          targetScope: (r.targetScope ?? {}) as FollowUpStrategy['targetScope'],
          steps: (stepsByStrategy.get(r.id) ?? []).map((s) => ({
            seq: s.seq,
            dayOffset: s.dayOffset,
            title: s.title,
            templateId: s.templateId ?? undefined,
            content: s.content ?? undefined,
            channel: s.channel as 'email',
            isBreakup: s.isBreakup,
          })),
          autoSendPolicy: r.autoSendPolicy,
          enabled: r.enabled,
          isDefault: r.isDefault,
          createdAt: r.createdAt.toISOString(),
        })),
        total: countRow?.n ?? 0,
        page: query.page,
        pageSize: query.pageSize,
      };
    });
  }

  /** 07 §3.3 新建策略：业务校验 42201，写 followUpStrategy + 多条 step（seq 归一、isBreakup 系统置位） */
  async createStrategy(ctx: OrgScopeContext, dto: UpsertStrategyDto): Promise<{ strategyId: string }> {
    this.assertStrategyWritable(ctx);
    this.validateStrategy(dto);
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const strategyId = createId('strat');
      const now = new Date();
      await tx.insert(schema.followUpStrategy).values({
        id: strategyId,
        orgId: ctx.orgId,
        name: dto.name.trim(),
        targetScope: dto.targetScope ?? {},
        autoSendPolicy: dto.autoSendPolicy ?? 'manual_review',
        enabled: dto.enabled ?? true,
        isDefault: false,
        createdBy: ctx.userId,
        createdAt: now,
        updatedAt: now,
      });
      try {
        await this.insertSteps(tx, ctx.orgId, strategyId, dto.steps);
      } catch (err) {
        // dayOffset 唯一约束（uq_fstep_strategy_day）兜底并发竞态 → 42201
        if (isUniqueViolation(err)) {
          throw new BizException(ErrorCode.BIZ_VALIDATION, 'Day 偏移不可重复');
        }
        throw err;
      }
      return { strategyId };
    });
  }

  /** 07 §3.3 编辑策略：isDefault → 40901；更新策略头 + 事务内重建 steps */
  async updateStrategy(
    ctx: OrgScopeContext,
    strategyId: string,
    dto: UpsertStrategyDto,
  ): Promise<{ strategyId: string }> {
    this.assertStrategyWritable(ctx);
    this.validateStrategy(dto);
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const [strategy] = await tx
        .select({ id: schema.followUpStrategy.id, isDefault: schema.followUpStrategy.isDefault })
        .from(schema.followUpStrategy)
        .where(and(eq(schema.followUpStrategy.id, strategyId), eq(schema.followUpStrategy.orgId, ctx.orgId)))
        .limit(1);
      if (!strategy) {
        throw new BizException(ErrorCode.NOT_FOUND, '策略不存在');
      }
      if (strategy.isDefault) {
        throw new BizException(ErrorCode.CONFLICT, '默认策略不可直接修改，请复制后编辑');
      }

      const now = new Date();
      await tx
        .update(schema.followUpStrategy)
        .set({
          name: dto.name.trim(),
          targetScope: dto.targetScope ?? {},
          autoSendPolicy: dto.autoSendPolicy ?? 'manual_review',
          enabled: dto.enabled ?? true,
          updatedAt: now,
        })
        .where(eq(schema.followUpStrategy.id, strategyId));

      await tx
        .delete(schema.followUpStrategyStep)
        .where(
          and(
            eq(schema.followUpStrategyStep.strategyId, strategyId),
            eq(schema.followUpStrategyStep.orgId, ctx.orgId),
          ),
        );
      try {
        await this.insertSteps(tx, ctx.orgId, strategyId, dto.steps);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new BizException(ErrorCode.BIZ_VALIDATION, 'Day 偏移不可重复');
        }
        throw err;
      }
      return { strategyId };
    });
  }

  /** 07 §3.3 删除策略：isDefault / 被进行中任务引用 → 40901 */
  async deleteStrategy(ctx: OrgScopeContext, strategyId: string): Promise<{ deleted: boolean }> {
    this.assertStrategyWritable(ctx);
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const [strategy] = await tx
        .select({ id: schema.followUpStrategy.id, isDefault: schema.followUpStrategy.isDefault })
        .from(schema.followUpStrategy)
        .where(and(eq(schema.followUpStrategy.id, strategyId), eq(schema.followUpStrategy.orgId, ctx.orgId)))
        .limit(1);
      if (!strategy) {
        throw new BizException(ErrorCode.NOT_FOUND, '策略不存在');
      }
      if (strategy.isDefault) {
        throw new BizException(ErrorCode.CONFLICT, '默认策略不可删除');
      }
      const [ongoing] = await tx
        .select({ id: schema.followUpTask.id })
        .from(schema.followUpTask)
        .where(
          and(
            eq(schema.followUpTask.strategyId, strategyId),
            eq(schema.followUpTask.orgId, ctx.orgId),
            notInArray(schema.followUpTask.status, ['completed', 'paused']),
          ),
        )
        .limit(1);
      if (ongoing) {
        throw new BizException(ErrorCode.CONFLICT, '策略正在被进行中任务引用，不可删除');
      }

      await tx
        .delete(schema.followUpStrategyStep)
        .where(
          and(
            eq(schema.followUpStrategyStep.strategyId, strategyId),
            eq(schema.followUpStrategyStep.orgId, ctx.orgId),
          ),
        );
      await tx
        .delete(schema.followUpStrategy)
        .where(and(eq(schema.followUpStrategy.id, strategyId), eq(schema.followUpStrategy.orgId, ctx.orgId)));
      return { deleted: true };
    });
  }

  /** 07 §3.4 执行记录：该策略下所有 follow_up_task 的执行记录，按 sentAt desc */
  async executions(
    ctx: OrgScopeContext,
    strategyId: string,
    page: number,
    pageSize: number,
  ): Promise<{ items: FollowUpExecution[]; total: number; page: number; pageSize: number }> {
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const [strategy] = await tx
        .select({ id: schema.followUpStrategy.id })
        .from(schema.followUpStrategy)
        .where(and(eq(schema.followUpStrategy.id, strategyId), eq(schema.followUpStrategy.orgId, ctx.orgId)))
        .limit(1);
      if (!strategy) {
        throw new BizException(ErrorCode.NOT_FOUND, '策略不存在');
      }

      const tasks = await tx
        .select({ id: schema.followUpTask.id })
        .from(schema.followUpTask)
        .where(and(eq(schema.followUpTask.strategyId, strategyId), eq(schema.followUpTask.orgId, ctx.orgId)));
      const taskIds = tasks.map((t) => t.id);
      if (taskIds.length === 0) {
        return { items: [], total: 0, page, pageSize };
      }

      const where = and(
        eq(schema.followUpExecution.orgId, ctx.orgId),
        inArray(schema.followUpExecution.followUpTaskId, taskIds),
      );
      const rows = await tx
        .select()
        .from(schema.followUpExecution)
        .where(where)
        .orderBy(
          sql`${schema.followUpExecution.sentAt} desc nulls last`,
          desc(schema.followUpExecution.createdAt),
        )
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const [countRow] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.followUpExecution)
        .where(where);

      return {
        items: rows.map((r) => ({
          executionId: r.id,
          followUpTaskId: r.followUpTaskId,
          stepTitle: r.stepTitle,
          sentAt: r.sentAt?.toISOString() ?? null,
          status: r.status,
          content: r.content ?? undefined,
          approvedBy: r.approvedBy ?? undefined,
          skipReason: r.skipReason ?? undefined,
        })),
        total: countRow?.n ?? 0,
        page,
        pageSize,
      };
    });
  }

  /**
   * 07 §3.5 应用策略到客户：customerIds 非空 40001、客户不存在 40001；
   * 每客户仅 1 个进行中任务（非 completed/paused），已存在 → skipped task_exists；
   * 创建 followUpTask：currentStage='follow_up_1'、nextRunAt=computeDeferredNextRunAt
   * 对齐首步 dayOffset 与发送窗口（org.timezone）；status 按到期时点推导：
   * 落点 ≤ now（dayOffset=0 且窗口内）→ ready（到期即可入队），未来 → scheduled（07 §1.2）。
   * 不落 ai_task（由 Scheduler/follow-up-scanner 驱动）。
   */
  async apply(
    ctx: OrgScopeContext,
    strategyId: string,
    dto: ApplyStrategyDto,
  ): Promise<{
    created: { customerId: string; followUpTaskId: string }[];
    skipped: { customerId: string; reason: 'task_exists' }[];
  }> {
    if (!dto.customerIds || dto.customerIds.length === 0) {
      throw new BizException(ErrorCode.BAD_REQUEST, 'customerIds 不能为空');
    }
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const [strategy] = await tx
        .select({ id: schema.followUpStrategy.id })
        .from(schema.followUpStrategy)
        .where(and(eq(schema.followUpStrategy.id, strategyId), eq(schema.followUpStrategy.orgId, ctx.orgId)))
        .limit(1);
      if (!strategy) {
        throw new BizException(ErrorCode.NOT_FOUND, '策略不存在');
      }

      const steps = await tx
        .select({ seq: schema.followUpStrategyStep.seq, dayOffset: schema.followUpStrategyStep.dayOffset })
        .from(schema.followUpStrategyStep)
        .where(
          and(
            eq(schema.followUpStrategyStep.strategyId, strategyId),
            eq(schema.followUpStrategyStep.orgId, ctx.orgId),
          ),
        )
        .orderBy(asc(schema.followUpStrategyStep.seq));
      const firstDay = steps[0]?.dayOffset ?? 0;

      const orgCtx = await this.orgSendContext(tx, ctx.orgId);
      const now = new Date();

      // 批量预筛进行中任务（非 completed/paused）
      const ongoingRows = await tx
        .select({ customerId: schema.followUpTask.customerId, status: schema.followUpTask.status })
        .from(schema.followUpTask)
        .where(
          and(
            eq(schema.followUpTask.orgId, ctx.orgId),
            inArray(schema.followUpTask.customerId, dto.customerIds),
            notInArray(schema.followUpTask.status, ['completed', 'paused']),
          ),
        );
      const ongoing = new Set(ongoingRows.map((r) => r.customerId));

      const created: { customerId: string; followUpTaskId: string }[] = [];
      const skipped: { customerId: string; reason: 'task_exists' }[] = [];

      for (const customerId of dto.customerIds) {
        const [cust] = await tx
          .select({ id: schema.customer.id, ownerId: schema.customer.ownerId })
          .from(schema.customer)
          .where(and(eq(schema.customer.id, customerId), notDeleted(schema.customer.deletedAt)))
          .limit(1);
        if (!cust) {
          throw new BizException(ErrorCode.BAD_REQUEST, `客户 ${customerId} 不存在`);
        }
        // scope 裁剪：sales(self) 仅可操作自己的客户（越权 40301）
        assertResourceAccess(cust, ctx);

        if (ongoing.has(customerId)) {
          skipped.push({ customerId, reason: 'task_exists' });
          continue;
        }

        const rawTarget = new Date(now.getTime() + Math.max(firstDay, 0) * 86_400_000);
        const nextRunAt = computeDeferredNextRunAt({
          now,
          nextRunAt: rawTarget,
          lastOutboundAt: null,
          minTouchIntervalDays: orgCtx.minTouchIntervalDays,
          timeZone: orgCtx.timeZone,
          ...(orgCtx.window ? { window: orgCtx.window } : {}),
        });

        const taskId = createId('ftask');
        const inserted = await tx
          .insert(schema.followUpTask)
          .values({
            id: taskId,
            orgId: ctx.orgId,
            customerId,
            strategyId,
            currentStage: 'follow_up_1',
            nextRunAt,
            // 已到期（落点 ≤ now）→ ready；落在未来（含窗口顺延）→ scheduled
            status: nextRunAt.getTime() <= now.getTime() ? 'ready' : 'scheduled',
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .returning({ id: schema.followUpTask.id });
        if (inserted.length === 0) {
          // 同策略已完成任务复用客户（uq_ftask_org_customer_strategy）→ 按已存在跳过
          skipped.push({ customerId, reason: 'task_exists' });
          continue;
        }
        created.push({ customerId, followUpTaskId: taskId });
      }

      return { created, skipped };
    });
  }

  // ===== helpers =====

  /** 策略写操作仅 manager/admin（sales 越权 40301，对齐 16 §2.7 权限矩阵 settings 口径） */
  private assertStrategyWritable(ctx: OrgScopeContext): void {
    if (ctx.role === 'sales') {
      throw new BizException(ErrorCode.FORBIDDEN, '跟进策略管理仅经理/管理员可操作');
    }
  }

  /** 策略保存业务校验（07 §3.3，对齐 mock validateStrategy）：42201 */
  private validateStrategy(dto: UpsertStrategyDto): void {
    if (!dto.name || !dto.name.trim()) {
      throw new BizException(ErrorCode.BIZ_VALIDATION, '策略名称必填');
    }
    const steps = dto.steps ?? [];
    if (steps.length === 0) {
      throw new BizException(ErrorCode.BIZ_VALIDATION, '至少配置一个跟进步骤');
    }
    const days = steps.map((s) => s.dayOffset);
    if (new Set(days).size !== days.length) {
      throw new BizException(ErrorCode.BIZ_VALIDATION, 'Day 偏移不可重复');
    }
    for (let i = 1; i < days.length; i += 1) {
      if (days[i]! <= days[i - 1]!) {
        throw new BizException(ErrorCode.BIZ_VALIDATION, 'Day 偏移必须递增');
      }
    }
    if (steps.some((s) => s.isBreakup) && dto.autoSendPolicy === 'auto_send') {
      throw new BizException(ErrorCode.BIZ_VALIDATION, 'Break-up Email 节点强制人工审核，不可选择自动发送');
    }
  }

  /** 批量写 steps：seq 归一（下标+1）、isBreakup 系统置位、channel 固定 email（对齐 mock sanitizeSteps） */
  private async insertSteps(tx: Tx, orgId: string, strategyId: string, steps: StrategyStepDto[]): Promise<void> {
    if (steps.length === 0) {
      return;
    }
    await tx.insert(schema.followUpStrategyStep).values(
      steps.map((step, index) => ({
        id: createId('sstep'),
        orgId,
        strategyId,
        seq: index + 1,
        dayOffset: step.dayOffset,
        title: step.title,
        templateId: step.isBreakup ? null : step.templateId ?? null,
        content: step.isBreakup || !step.templateId ? step.content ?? null : null,
        channel: 'email',
        isBreakup: Boolean(step.isBreakup),
      })),
    );
  }

  private async orgTimeZone(tx: Tx, orgId: string): Promise<string> {
    const [orgRow] = await tx
      .select({ timezone: schema.org.timezone })
      .from(schema.org)
      .where(eq(schema.org.id, orgId))
      .limit(1);
    return orgRow?.timezone ?? 'Asia/Shanghai';
  }

  /** org 时区 + 发送规则（sendRules 缺省 09–18 窗口、minTouchIntervalDays 3） */
  private async orgSendContext(
    tx: Tx,
    orgId: string,
  ): Promise<{ timeZone: string; minTouchIntervalDays: number; window?: SendWindow }> {
    const [orgRow] = await tx
      .select({ timezone: schema.org.timezone, sendRules: schema.org.sendRules })
      .from(schema.org)
      .where(eq(schema.org.id, orgId))
      .limit(1);
    const sendRules = (orgRow?.sendRules ?? null) as Record<string, unknown> | null;
    const window = parseSendWindow(sendRules);
    return {
      timeZone: orgRow?.timezone ?? 'Asia/Shanghai',
      minTouchIntervalDays: Number(sendRules?.['minTouchIntervalDays'] ?? 3),
      ...(window ? { window } : {}),
    };
  }

  /** L = 该客户最近一次 outbound 邮件（含人工，07 频控口径，与 follow-up-scanner 一致） */
  private async lastOutboundAt(tx: Tx, customerId: string): Promise<Date | null> {
    const [lastOut] = await tx
      .select({ sentAt: schema.message.sentAt, createdAt: schema.message.createdAt })
      .from(schema.message)
      .innerJoin(schema.conversation, eq(schema.conversation.id, schema.message.conversationId))
      .where(
        and(
          eq(schema.conversation.customerId, customerId),
          eq(schema.message.direction, 'out'),
          eq(schema.message.status, 'sent'),
        ),
      )
      .orderBy(desc(schema.message.createdAt))
      .limit(1);
    return lastOut?.sentAt ?? lastOut?.createdAt ?? null;
  }
}

/** 策略行（07 §1.3/§1.4 + ER 05 §2.4） */
export interface FollowUpStrategy {
  strategyId: string;
  name: string;
  targetScope: { customerValue: Array<'high' | 'medium' | 'low'>; industry?: string[]; tags?: string[] };
  steps: {
    seq: number;
    dayOffset: number;
    title: string;
    templateId?: string;
    content?: string;
    channel: 'email';
    isBreakup?: boolean;
  }[];
  autoSendPolicy: 'manual_review' | 'auto_send' | 'value_based';
  enabled: boolean;
  isDefault?: boolean;
  createdAt?: string;
}
