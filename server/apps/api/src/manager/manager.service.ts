/**
 * 13 AI 外贸经理服务（P1-13-01~07）。
 *
 * 设计要点：
 * - **口径同源**：四项指标复用 `AnalyticsService`（15 数据中心），团队效率复用 `EmployeesService`（02 员工卡片），
 *   本服务不写第二份聚合 SQL——13 §4「数字必须可核实、两页不得出现不同数字」；
 * - **发现实时刷新**：发现列表按需重算（机会 = 近 30 天 vs 前 30 天询盘环比；风险 = 高价值客户静默 ≥14 天），
 *   幂等 upsert 进 `ai_discovery`（键 = type + title），已执行状态不被刷新覆盖；
 * - **一键仅发起**：动作白名单 `start_lead_task` / `enable_reactivation_strategy`，复用 03 / 07 service，
 *   外发仍走各模块审批（13 §7）；已执行发现直接回放 executedRef，不重复创建；
 * - **报告异步**：落 `business_report(generating)` + 投 `business_analysis` 任务（worker 产出五段 Markdown），
 *   本期仅手动生成，POST /manager/reports/generate 为唯一入口（13 §4）。
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  BizException,
  DISCOVERY_STATUS,
  ErrorCode,
  MANAGER_DISCOVERY_ACTIONS,
  MANAGER_DISCOVERY_ACTION_LABEL,
  MANAGER_HIGH_VALUE_SCORE,
  MANAGER_INACTIVE_DAYS,
  buildOpportunityDiscoveries,
  buildRiskDiscovery,
  createId,
  getZonedWallTime,
  managerInsightWindow,
  previousPeriodRange,
  reportPeriodLabel,
  type ManagerDiscoveryAction,
  type ManagerReportPeriod,
} from '@tradepilot/core';
import {
  fetchOpportunityCandidates,
  fetchStaleHighValueCustomers,
  listDiscoveries,
  markDiscoveryExecuted,
  schema,
  upsertDiscoveries,
  withOrg,
  type Db,
  type OrgScopeContext,
  type Tx,
} from '@tradepilot/db';
import { AnalyticsService } from '../analytics/analytics.service.js';
import type { AnalyticsFilterDto } from '../analytics/analytics.dto.js';
import { EmployeesService } from '../employees/employees.service.js';
import { LeadsService } from '../leads/leads.service.js';
import { FollowUpsService } from '../follow-ups/follow-ups.service.js';
import { createLeadTaskSchema } from '../leads/leads.dto.js';
import { upsertStrategySchema } from '../follow-ups/follow-ups.dto.js';
import { TasksService } from '../tasks/tasks.service.js';
import { DB } from '../db/db.module.js';
import type {
  DiscoveryItemDto,
  DiscoveryListResp,
  ExecuteDiscoveryResp,
  GenerateReportResp,
  ListReportsQuery,
  ManagerDiscoveriesQuery,
  ManagerOverviewQuery,
  ManagerOverviewResp,
  ReportDetailDto,
  ReportListItemDto,
  ReportListResp,
  TeamEfficiencyResp,
} from './manager.dto.js';

/** 报告指标区间（org 时区当地日历口径） */
interface DateRange {
  start: string;
  end: string;
}

@Injectable()
export class ManagerService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
    @Inject(EmployeesService) private readonly employees: EmployeesService,
    @Inject(LeadsService) private readonly leads: LeadsService,
    @Inject(FollowUpsService) private readonly followUps: FollowUpsService,
    @Inject(TasksService) private readonly tasks: TasksService,
  ) {}

  /** 13 §3.1 今日经营概览（date 缺省今天；四项指标与 15 数据中心同源） */
  async overview(ctx: OrgScopeContext, query: ManagerOverviewQuery): Promise<ManagerOverviewResp> {
    const timeZone = await this.orgTimeZone(ctx.orgId);
    const date = query.date ?? todayKey(timeZone);
    return this.metricsFor(ctx, { start: date, end: date });
  }

  /**
   * 13 §3.2 AI 发现列表。
   * 每次请求按当前窗口重算并幂等写回（保证页面数字与库内证据一致），再按 type 过滤返回未过期项。
   */
  async discoveries(
    ctx: OrgScopeContext,
    query: ManagerDiscoveriesQuery,
  ): Promise<DiscoveryListResp> {
    const items = await withOrg(this.db, ctx.orgId, async (tx) => {
      const timeZone = await this.orgTimeZoneIn(tx, ctx.orgId);
      const window = managerInsightWindow({ anchor: new Date(), timeZone });

      const candidates = await fetchOpportunityCandidates(tx, window);
      const opportunities = buildOpportunityDiscoveries(candidates, {
        startDate: toDateKey(window.recentStart),
        endDate: toDateKey(new Date(window.recentEnd.getTime() - 1)),
      });

      const staleCustomers = await fetchStaleHighValueCustomers(tx, {
        scoreThreshold: MANAGER_HIGH_VALUE_SCORE,
        cutoff: new Date(Date.now() - MANAGER_INACTIVE_DAYS * 86_400_000),
        limit: 20,
      });
      const risk = buildRiskDiscovery(staleCustomers);
      const drafts = risk ? [...opportunities, risk] : opportunities;

      // 幂等写回：命中同 (type,title) 只刷新证据，执行状态保留；本轮未检出的 new 行置 dismissed
      await upsertDiscoveries(tx, ctx.orgId, drafts);

      const rows = await listDiscoveries(tx, { type: query.type });
      return rows.map((row) => this.toDiscoveryItem(row));
    });
    return { items };
  }

  /**
   * 13 §3.3 一键执行建议（白名单封闭为发起类动作）：
   * - `start_lead_task` → 复用 03 创建获客任务（返回 taskId）；
   * - `enable_reactivation_strategy` → 复用 07 创建重新激活策略（返回 strategyId）；
   * - 已 executed 的发现直接回放 executedRef（幂等，避免重复创建任务/策略）。
   * 注意：创建任务/策略各自开事务，故「读发现 → 调服务 → 回写」必须分三次事务，不能包在同一个 withOrg 里。
   */
  async execute(ctx: OrgScopeContext, discoveryId: string): Promise<ExecuteDiscoveryResp> {
    const row = await withOrg(this.db, ctx.orgId, async (tx) => {
      const [found] = await tx
        .select({
          id: schema.aiDiscovery.id,
          status: schema.aiDiscovery.status,
          suggestion: schema.aiDiscovery.suggestion,
          executedRef: schema.aiDiscovery.executedRef,
        })
        .from(schema.aiDiscovery)
        .where(and(eq(schema.aiDiscovery.id, discoveryId), eq(schema.aiDiscovery.orgId, ctx.orgId)))
        .limit(1);
      return found ?? null;
    });
    if (!row) {
      throw BizException.notFound(`AI 发现不存在: ${discoveryId}`);
    }

    const suggestion = row.suggestion as {
      action?: string;
      payload?: Record<string, unknown>;
    } | null;
    const action = suggestion?.action;
    if (!action || !(MANAGER_DISCOVERY_ACTIONS as readonly string[]).includes(action)) {
      throw new BizException(ErrorCode.BIZ_VALIDATION, `不支持的一键动作: ${action ?? '缺失'}`);
    }

    // 幂等回放：已执行过的发现不再创建第二个任务/策略（13 §4「可撤销、不产生对外效果」）
    if (row.status === DISCOVERY_STATUS.EXECUTED && row.executedRef) {
      const ref = row.executedRef as { taskId?: string; strategyId?: string };
      return {
        discoveryId,
        action,
        ...(ref.taskId ? { taskId: ref.taskId } : {}),
        ...(ref.strategyId ? { strategyId: ref.strategyId } : {}),
      };
    }

    const payload = suggestion?.payload ?? {};
    let executedRef: Record<string, unknown>;
    if (action === 'start_lead_task') {
      const parsed = createLeadTaskSchema.safeParse({
        goalText: payload['goalText'],
        parsed: payload['parsed'],
      });
      if (!parsed.success) {
        throw new BizException(
          ErrorCode.BIZ_VALIDATION,
          `发现缺少获客任务参数: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
        );
      }
      const created = await this.leads.createTask(ctx, parsed.data);
      executedRef = { action, taskId: created.taskId };
    } else {
      const parsed = upsertStrategySchema.safeParse(payload);
      if (!parsed.success) {
        throw new BizException(
          ErrorCode.BIZ_VALIDATION,
          `发现缺少策略参数: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
        );
      }
      const created = await this.followUps.createStrategy(ctx, parsed.data);
      executedRef = { action, strategyId: created.strategyId };
    }

    await withOrg(this.db, ctx.orgId, (tx) => markDiscoveryExecuted(tx, discoveryId, executedRef));

    const result: ExecuteDiscoveryResp = { discoveryId, action };
    if (typeof executedRef['taskId'] === 'string') {
      result.taskId = executedRef['taskId'];
    }
    if (typeof executedRef['strategyId'] === 'string') {
      result.strategyId = executedRef['strategyId'];
    }
    return result;
  }

  /** 13 §1.3 AI 团队效率（与 02 员工卡片同源：今日任务计数 + kpiPct 口径） */
  async teamEfficiency(ctx: OrgScopeContext): Promise<TeamEfficiencyResp> {
    const rows = await this.employees.teamEfficiency(ctx);
    return {
      items: rows.map((row) => ({
        employeeId: row.employeeId,
        role: row.role,
        name: row.name,
        // target 未配置 → 不返回 kpiPct/metric/target（13 §1.3 v0.3，前端显示「未设目标」）
        ...(row.kpiPct === null ? {} : { kpiPct: row.kpiPct }),
        ...(row.metric === null ? {} : { metric: row.metric }),
        ...(row.target === null ? {} : { target: row.target }),
        achieved: row.achieved,
        period: row.period,
      })),
    };
  }

  /**
   * 13 §3.4 生成经营报告（异步）：
   * ① 取本期 + 上一期指标快照（与 overview 同源）与团队效率快照；
   * ② 落 `business_report(generating)`；③ 投 `business_analysis` 任务；④ 回填 task_id。
   * 快照放进 task.input，worker 直接消费（避免 worker 重复实现统计口径）。
   */
  async generateReport(
    ctx: OrgScopeContext,
    dto: { period: ManagerReportPeriod },
  ): Promise<GenerateReportResp> {
    const timeZone = await this.orgTimeZone(ctx.orgId);
    const range = periodRange(dto.period, timeZone, new Date());
    const previous = previousPeriodRange(dto.period, range);

    const [overview, previousOverview, team] = await Promise.all([
      this.metricsFor(ctx, range),
      this.metricsFor(ctx, previous),
      this.employees.teamEfficiency(ctx),
    ]);

    const employeeId = await withOrg(this.db, ctx.orgId, (tx) =>
      this.managerEmployeeId(tx, ctx.orgId),
    );

    const reportId = createId('rpt');
    await withOrg(this.db, ctx.orgId, (tx) =>
      tx.insert(schema.businessReport).values({
        id: reportId,
        orgId: ctx.orgId,
        period: dto.period,
        periodStart: range.start,
        periodEnd: range.end,
        status: 'generating',
      }),
    );

    const created = await this.tasks.create(ctx.orgId, ctx.userId, {
      employeeId,
      type: 'business_analysis',
      title: `${reportPeriodLabel(dto.period)}经营分析（${range.start} ~ ${range.end}）`,
      input: {
        reportId,
        period: dto.period,
        periodStart: range.start,
        periodEnd: range.end,
        overview,
        previousOverview,
        previousPeriod: previous,
        team,
      },
    });

    await withOrg(this.db, ctx.orgId, (tx) =>
      tx
        .update(schema.businessReport)
        .set({ taskId: created.taskId, updatedAt: new Date() })
        .where(eq(schema.businessReport.id, reportId)),
    );

    return { taskId: created.taskId, reportId, status: created.status, period: dto.period };
  }

  /** 13 §1.4 报告列表（period 过滤 + 分页） */
  async listReports(ctx: OrgScopeContext, query: ListReportsQuery): Promise<ReportListResp> {
    const { page, pageSize } = query;
    return withOrg(this.db, ctx.orgId, async (tx) => {
      const where =
        query.period === 'all'
          ? eq(schema.businessReport.orgId, ctx.orgId)
          : and(
              eq(schema.businessReport.orgId, ctx.orgId),
              eq(schema.businessReport.period, query.period),
            );

      const [countRow] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.businessReport)
        .where(where);
      const rows = await tx
        .select({
          id: schema.businessReport.id,
          period: schema.businessReport.period,
          periodStart: schema.businessReport.periodStart,
          periodEnd: schema.businessReport.periodEnd,
          status: schema.businessReport.status,
          taskId: schema.businessReport.taskId,
          generatedAt: schema.businessReport.generatedAt,
          createdAt: schema.businessReport.createdAt,
        })
        .from(schema.businessReport)
        .where(where)
        .orderBy(desc(schema.businessReport.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      return {
        items: rows.map((row) => this.toReportItem(row)),
        total: countRow?.n ?? 0,
        page,
        pageSize,
      };
    });
  }

  /** 13 §1.4 报告详情（generating/failed → content 为空，前端展示状态） */
  async getReport(ctx: OrgScopeContext, reportId: string): Promise<ReportDetailDto> {
    const row = await withOrg(this.db, ctx.orgId, async (tx) => {
      const [found] = await tx
        .select({
          id: schema.businessReport.id,
          period: schema.businessReport.period,
          periodStart: schema.businessReport.periodStart,
          periodEnd: schema.businessReport.periodEnd,
          status: schema.businessReport.status,
          content: schema.businessReport.content,
          citations: schema.businessReport.citations,
          taskId: schema.businessReport.taskId,
          generatedAt: schema.businessReport.generatedAt,
          createdAt: schema.businessReport.createdAt,
        })
        .from(schema.businessReport)
        .where(
          and(eq(schema.businessReport.id, reportId), eq(schema.businessReport.orgId, ctx.orgId)),
        )
        .limit(1);
      return found ?? null;
    });
    if (!row) {
      throw BizException.notFound(`经营报告不存在: ${reportId}`);
    }
    return {
      ...this.toReportItem(row),
      content: row.content ?? null,
      citations: row.citations ?? [],
    };
  }

  // ===== 内部：指标 / 时区 / 映射 =====

  /**
   * 区间四项指标：newCustomers/newInquiries/newQuotes 由 trend 逐日求和（15 §3.1），
   * dealsClosed 取下钻 total（15 §3.4 与明细同源，13 §1.1 口径）。
   */
  private async metricsFor(ctx: OrgScopeContext, range: DateRange): Promise<ManagerOverviewResp> {
    const filter: AnalyticsFilterDto = {
      period: 'custom',
      startDate: range.start,
      endDate: range.end,
      country: 'all',
      employeeId: 'all',
    };
    const [trend, deals] = await Promise.all([
      this.analytics.customerTrend(ctx, filter),
      this.analytics.drilldown(ctx, { ...filter, metric: 'deals_closed', page: 1, pageSize: 1 }),
    ]);
    return {
      newCustomers: sumBy(trend.trend, (p) => p.newCustomers),
      newInquiries: sumBy(trend.trend, (p) => p.newInquiries),
      newQuotes: sumBy(trend.trend, (p) => p.newQuotes),
      dealsClosed: deals.total,
    };
  }

  private async orgTimeZone(orgId: string): Promise<string> {
    return withOrg(this.db, orgId, (tx) => this.orgTimeZoneIn(tx, orgId));
  }

  private async orgTimeZoneIn(tx: Tx, orgId: string): Promise<string> {
    const [row] = await tx
      .select({ timezone: schema.org.timezone })
      .from(schema.org)
      .where(eq(schema.org.id, orgId))
      .limit(1);
    return row?.timezone ?? 'Asia/Shanghai';
  }

  /** 解析 AI 经理员工（business_analysis 执行者）；缺失即配置不完整 → 42201 */
  private async managerEmployeeId(tx: Tx, orgId: string): Promise<string> {
    const [row] = await tx
      .select({ id: schema.aiEmployee.id })
      .from(schema.aiEmployee)
      .where(and(eq(schema.aiEmployee.orgId, orgId), eq(schema.aiEmployee.role, 'manager')))
      .orderBy(schema.aiEmployee.createdAt)
      .limit(1);
    if (!row) {
      throw new BizException(
        ErrorCode.BIZ_VALIDATION,
        '未找到 AI 外贸经理员工，无法生成经营报告（请在员工中心创建 manager 角色员工）',
      );
    }
    return row.id;
  }

  private toDiscoveryItem(row: {
    id: string;
    type: string;
    title: string;
    detail: string;
    evidence: { text: string; source?: string; ref?: string }[] | null;
    suggestion: Record<string, unknown> | null;
    status: string;
    executedRef: Record<string, unknown> | null;
    executedAt: Date | null;
    createdAt: Date;
  }): DiscoveryItemDto {
    const suggestion = (row.suggestion ?? {}) as {
      label?: string;
      action?: string;
      payload?: Record<string, unknown>;
    };
    const action = suggestion.action ?? '';
    return {
      discoveryId: row.id,
      type: row.type,
      title: row.title,
      detail: row.detail,
      evidence: row.evidence ?? [],
      suggestion: {
        label: suggestion.label ?? '',
        action,
        payload: suggestion.payload ?? {},
      },
      actions: MANAGER_DISCOVERY_ACTION_LABEL[action as ManagerDiscoveryAction] ?? '查看建议',
      status: row.status,
      executedRef: row.executedRef ?? null,
      executedAt: row.executedAt ? row.executedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toReportItem(row: {
    id: string;
    period: string;
    periodStart: string;
    periodEnd: string;
    status: string;
    taskId: string | null;
    generatedAt: Date | null;
    createdAt: Date;
  }): ReportListItemDto {
    return {
      reportId: row.id,
      period: row.period,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      status: row.status,
      taskId: row.taskId,
      generatedAt: row.generatedAt ? row.generatedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

// ===== 纯函数 helpers（org 时区日历口径，与 15 数据中心一致） =====

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftDateKey(dateKey: string, days: number): string {
  const base = new Date(`${dateKey}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return toDateKey(base);
}

/** 当地周内偏移（周一 = 0，与 15 §3.1 this_week 口径一致） */
function localWeekdayIndex(dateKey: string): number {
  return (new Date(`${dateKey}T00:00:00Z`).getUTCDay() + 6) % 7;
}

function todayKey(timeZone: string): string {
  const wall = getZonedWallTime(new Date(), timeZone);
  return `${wall.year}-${pad2(wall.month)}-${pad2(wall.day)}`;
}

/** 报告区间：daily = 今天；weekly = 本周一 ~ 今天；monthly = 本月 1 日 ~ 今天 */
function periodRange(period: ManagerReportPeriod, timeZone: string, now: Date): DateRange {
  const wall = getZonedWallTime(now, timeZone);
  const today = `${wall.year}-${pad2(wall.month)}-${pad2(wall.day)}`;
  if (period === 'weekly') {
    return { start: shiftDateKey(today, -localWeekdayIndex(today)), end: today };
  }
  if (period === 'monthly') {
    return { start: `${wall.year}-${pad2(wall.month)}-01`, end: today };
  }
  return { start: today, end: today };
}

function sumBy<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}
