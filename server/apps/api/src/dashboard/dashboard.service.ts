import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { BizException, ErrorCode, getZonedWallTime, zonedWallTimeToUtc } from '@tradepilot/core';
import {
  schema,
  withOrg,
  applyOwnerScope,
  notDeleted,
  resolveScope,
  scopeAnd,
  type Db,
  type OrgScopeContext,
  type Tx,
} from '@tradepilot/db';
import { DB } from '../db/db.module.js';
import { ManagerService } from '../manager/manager.service.js';
import type {
  DashboardDailyReport,
  DashboardEmployee,
  DashboardHighValueCustomer,
  DashboardKpi,
  DashboardPendingItem,
  DashboardQuery,
  DashboardSummary,
  GenerateDailyReportDto,
  GenerateDailyReportResp,
} from './dashboard.dto.js';

/**
 * 01 Dashboard 工作台服务（接口 01 §3.1，M5-D2）：
 * - greeting：AI 员工在线数（status ∈ working/waiting_approval）与总人数（org 级，不做 owner scope）；
 * - kpis：new_customers / new_inquiries（org.timezone 当地日历「今日」口径）+ D1 随 09/10 恢复的
 *   new_quotes（今日新建报价数，scope 按 quotation.owner_id）/ estimated_revenue（今日「已发送/已成交」
 *   报价金额合计，coalesce(won_at, sent_at) 落窗避免重复计）；环比基准 vs_yesterday：前值=昨日当地
 *   日历日，前值为 0 时 changePct=0/trend=flat；
 * - aiEmployees：员工卡片聚合——currentAction 依次取 waiting_approval 的「等待 N 个任务审核」/
 *   statusDetail / 最新 running·waiting_approval 任务 title，todayOutput 按角色文案取今日 ai_task 数
 *   （org 级，不做 owner scope）；
 * - highValueCustomers：未删客户按 score desc 取前 5（FR-04 Top N，无分数阈值，scope 裁剪）；
 * - pendingItems：D2 四类齐备——quote_approval（status=waiting_approval 的报价数）/
 *   high_value_overdue（score≥85 且近 7 天无 customer_activity，ER 04 超期口径）/
 *   customer_reply（未读会话）/ order_delay_risk（sales_order.risk='at_risk'），均按 scope 裁剪；
 * - dailyReport：D3 随 13 恢复（委托 ManagerService 取/生成经营报告），无数据时 40401。
 */

/** 员工在线口径（01 §1.1）：working + waiting_approval */
const ONLINE_EMPLOYEE_STATUSES = ['working', 'waiting_approval'] as const;

/** DB employee_status → Dashboard 4 值状态映射（02 卡片同口径：risk/failed→error，scheduled→idle） */
const DASH_STATUS: Record<string, DashboardEmployee['status']> = {
  working: 'working',
  waiting_approval: 'waiting_approval',
  scheduled: 'idle',
  risk: 'error',
  failed: 'error',
  idle: 'idle',
};

/** 今日产出文案（01 §1.3）：role → {label, unit}（对齐 FE Dashboard 卡口文案） */
const TODAY_OUTPUT_LABEL: Record<string, { label: string; unit: string }> = {
  lead_hunter: { label: '今日找到客户', unit: '个' },
  customer_researcher: { label: '今日分析客户', unit: '个' },
  sales: { label: '今日回复', unit: '封' },
  follow_up: { label: '今日跟进', unit: '个' },
  merchandiser: { label: '今日跟单', unit: '单' },
  manager: { label: '今日经营', unit: '个' },
};

@Injectable()
export class DashboardService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ManagerService) private readonly manager: ManagerService,
  ) {}

  /** 01 §3.1 首屏聚合（greeting/kpis/aiEmployees/highValueCustomers/pendingItems） */
  async summary(ctx: OrgScopeContext, _query: DashboardQuery): Promise<DashboardSummary> {
    const scope = resolveScope(ctx.role, ctx.scope);
    const scopeCtx = { ...ctx, scope };

    return withOrg(this.db, ctx.orgId, async (tx) => {
      const timeZone = await this.orgTimeZone(tx, ctx.orgId);
      const now = new Date();
      const greeting = await this.greeting(tx);
      const kpis = await this.kpis(tx, scopeCtx, now, timeZone);
      const aiEmployees = await this.aiEmployees(tx, now, timeZone);
      const highValueCustomers = await this.highValueCustomers(tx, scopeCtx);
      const pendingItems = await this.pendingItems(tx, scopeCtx, now);

      return { greeting, kpis, aiEmployees, highValueCustomers, pendingItems };
    });
  }

  /**
   * 01 §3.2 获取最新 AI 每日报告（D3：随 13 恢复）。
   * 口径：取本 org 最新一条 `period='daily'` 的 `business_report`（generating/failed 也返回状态，
   * 前端按状态展示「生成中/失败」），无任何日报 → 40401（01 §3.2 无报告语义）。
   */
  async dailyReport(ctx: OrgScopeContext): Promise<DashboardDailyReport> {
    const list = await this.manager.listReports(ctx, {
      period: 'daily',
      page: 1,
      pageSize: 1,
      sortOrder: 'desc',
    });
    const latest = list.items[0];
    if (!latest) {
      throw new BizException(ErrorCode.NOT_FOUND, '暂无 AI 每日报告（可发起生成）');
    }
    const detail = await this.manager.getReport(ctx, latest.reportId);
    return {
      reportId: detail.reportId,
      period: detail.period as DashboardDailyReport['period'],
      status: detail.status as DashboardDailyReport['status'],
      content: detail.content,
      generatedAt: detail.generatedAt,
      citations: detail.citations,
    };
  }

  /** 01 §3.3 触发生成 AI 每日报告（D3：复用 13 经营报告异步任务，worker 产出五段 Markdown） */
  async generateDailyReport(
    ctx: OrgScopeContext,
    dto: GenerateDailyReportDto,
  ): Promise<GenerateDailyReportResp> {
    const created = await this.manager.generateReport(ctx, { period: dto.period });
    return {
      taskId: created.taskId,
      reportId: created.reportId,
      status: created.status,
      period: created.period,
    };
  }

  /** 01 §1.1 问候区：在线（working/waiting_approval）与员工总数（org 级，RLS 隔离） */
  private async greeting(tx: Tx): Promise<DashboardSummary['greeting']> {
    const [online] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.aiEmployee)
      .where(inArray(schema.aiEmployee.status, [...ONLINE_EMPLOYEE_STATUSES]));
    const [total] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.aiEmployee);
    return { onlineEmployeeCount: online?.n ?? 0, onlineEmployeeTotal: total?.n ?? 0 };
  }

  /** 01 §1.2 KPI 卡（D1 全量：new_customers/new_inquiries/new_quotes/estimated_revenue；环比基准 vs_yesterday） */
  private async kpis(
    tx: Tx,
    scopeCtx: OrgScopeContext,
    now: Date,
    timeZone: string,
  ): Promise<DashboardKpi[]> {
    // 当地日历日窗口：今日 [todayStart, ∞) / 昨日 [yesterdayStart, todayStart)
    const todayStart = localDayStartUtc(now, timeZone);
    const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);

    const countCustomers = async (gteStart: Date, ltEnd?: Date) => {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.customer)
        .where(
          scopeAnd(
            notDeleted(schema.customer.deletedAt),
            applyOwnerScope(schema.customer.ownerId, scopeCtx),
            gte(schema.customer.createdAt, gteStart),
            ...(ltEnd ? [lt(schema.customer.createdAt, ltEnd)] : []),
          ),
        );
      return row?.n ?? 0;
    };

    const countInquiries = async (gteStart: Date, ltEnd?: Date) => {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.conversation)
        .innerJoin(schema.customer, eq(schema.customer.id, schema.conversation.customerId))
        .where(
          scopeAnd(
            notDeleted(schema.customer.deletedAt),
            applyOwnerScope(schema.customer.ownerId, scopeCtx),
            gte(schema.conversation.createdAt, gteStart),
            ...(ltEnd ? [lt(schema.conversation.createdAt, ltEnd)] : []),
          ),
        );
      return row?.n ?? 0;
    };

    const toKpi = (metric: DashboardKpi['metric'], cur: number, prev: number): DashboardKpi => {
      const trend: DashboardKpi['trend'] = cur > prev ? 'up' : 'down';
      return {
        metric,
        value: cur,
        comparePeriod: 'vs_yesterday',
        // 前值为 0 → 环比无基期：0/flat；否则 round((cur-prev)/prev*100)
        ...(prev === 0 || cur === prev
          ? { changePct: 0, trend: 'flat' as const }
          : { changePct: Math.round(((cur - prev) / prev) * 100), trend }),
      };
    };

    // ===== D1：09 报价 / 10 订单随模块交付恢复（new_quotes / estimated_revenue） =====
    const countQuotes = async (gteStart: Date, ltEnd?: Date) => {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.quotation)
        .where(
          scopeAnd(
            applyOwnerScope(schema.quotation.ownerId, scopeCtx),
            gte(schema.quotation.createdAt, gteStart),
            ...(ltEnd ? [lt(schema.quotation.createdAt, ltEnd)] : []),
          ),
        );
      return row?.n ?? 0;
    };

    /**
     * 预计成交额（01 §2 KPI「预计成交额」，依赖 09/10）：当地今日「已发送/已成交」报价金额合计。
     * 落窗时间取 `coalesce(won_at, sent_at)`——同一报价只在其最终状态时点计入一次（won 不再按 sent 重复计）。
     * 币种口径（MVP 假设）：单币种经营（默认 USD），多币种时按窗口内金额最大的币种标注 `currency`，
     * 金额为原始数值合计（不换算）；随 15/16 汇率口径统一后收敛（见 P1 进度总览 §14 假设）。
     */
    const revenueOf = async (gteStart: Date, ltEnd?: Date) => {
      const stamp = sql`coalesce(${schema.quotation.wonAt}, ${schema.quotation.sentAt})`;
      const rows = await tx
        .select({
          currency: schema.quotation.currency,
          amount: sql<string>`coalesce(sum(${schema.quotation.totalAmount}), 0)::text`,
        })
        .from(schema.quotation)
        .where(
          scopeAnd(
            applyOwnerScope(schema.quotation.ownerId, scopeCtx),
            inArray(schema.quotation.status, ['sent', 'won']),
            gte(stamp, gteStart),
            ...(ltEnd ? [lt(stamp, ltEnd)] : []),
          ),
        )
        .groupBy(schema.quotation.currency);

      const total = rows.reduce((acc, r) => acc + Number(r.amount), 0);
      const dominant = [...rows].sort((a, b) => Number(b.amount) - Number(a.amount))[0]?.currency;
      return { amount: total, currency: dominant ?? 'USD' };
    };

    const [quotesToday, quotesYesterday] = [
      await countQuotes(todayStart),
      await countQuotes(yesterdayStart, todayStart),
    ];
    const [revenueToday, revenueYesterday] = [
      await revenueOf(todayStart),
      await revenueOf(yesterdayStart, todayStart),
    ];

    return [
      toKpi(
        'new_customers',
        await countCustomers(todayStart),
        await countCustomers(yesterdayStart, todayStart),
      ),
      toKpi(
        'new_inquiries',
        await countInquiries(todayStart),
        await countInquiries(yesterdayStart, todayStart),
      ),
      toKpi('new_quotes', quotesToday, quotesYesterday),
      {
        ...toKpi('estimated_revenue', revenueToday.amount, revenueYesterday.amount),
        value: revenueToday.amount.toFixed(2),
        currency: revenueToday.currency,
      },
    ];
  }

  /**
   * 01 §1.3 AI 员工卡片（org 级；currentAction 优先 waiting 文案/statusDetail/task title；今日产出按角色文案）。
   * 聚合口径：员工列表 1 次查询 + 任务侧 3 次批量聚合（按 employee_id 分组），
   * 不做逐员工 N+1（种子组织员工可达数百，逐员工 3 查询会让首屏退化到秒级）。
   */
  private async aiEmployees(tx: Tx, now: Date, timeZone: string): Promise<DashboardEmployee[]> {
    const todayStart = localDayStartUtc(now, timeZone);
    const employees = await tx
      .select()
      .from(schema.aiEmployee)
      .orderBy(asc(schema.aiEmployee.createdAt));
    if (employees.length === 0) return [];

    const employeeIds = employees.map((e) => e.id);

    // 当前动作：各员工最新 running/waiting_approval 任务 title（沿用「updatedAt 最新一条」语义，内存取首个）
    const activeTasks = await tx
      .select({
        employeeId: schema.aiTask.employeeId,
        title: schema.aiTask.title,
        updatedAt: schema.aiTask.updatedAt,
      })
      .from(schema.aiTask)
      .where(
        and(
          inArray(schema.aiTask.employeeId, employeeIds),
          inArray(schema.aiTask.status, ['running', 'waiting_approval']),
        ),
      )
      .orderBy(desc(schema.aiTask.updatedAt));
    const latestTaskTitle = new Map<string, string>();
    for (const task of activeTasks) {
      if (task.employeeId && !latestTaskTitle.has(task.employeeId)) {
        latestTaskTitle.set(task.employeeId, task.title);
      }
    }

    // 今日产出：今日（org 当地日 00:00 起）创建的 ai_task 数，按员工分组
    const todayCounts = await tx
      .select({ employeeId: schema.aiTask.employeeId, n: sql<number>`count(*)::int` })
      .from(schema.aiTask)
      .where(
        and(
          inArray(schema.aiTask.employeeId, employeeIds),
          gte(schema.aiTask.createdAt, todayStart),
        ),
      )
      .groupBy(schema.aiTask.employeeId);
    const todayByEmployee = new Map(todayCounts.map((r) => [r.employeeId, r.n]));

    // 等待审核任务数，按员工分组
    const waitingCounts = await tx
      .select({ employeeId: schema.aiTask.employeeId, n: sql<number>`count(*)::int` })
      .from(schema.aiTask)
      .where(
        and(
          inArray(schema.aiTask.employeeId, employeeIds),
          eq(schema.aiTask.status, 'waiting_approval'),
        ),
      )
      .groupBy(schema.aiTask.employeeId);
    const waitingByEmployee = new Map(waitingCounts.map((r) => [r.employeeId, r.n]));

    return employees.map((emp) => {
      const status = DASH_STATUS[emp.status] ?? 'idle';
      const waitingApprovalCount = waitingByEmployee.get(emp.id) ?? 0;
      const roleLabel = TODAY_OUTPUT_LABEL[emp.role] ?? { label: '今日处理', unit: '个' };
      // currentAction：waiting_approval → 「等待 N 个任务审核」；占位（statusDetail）次之；再退回任务 title
      const currentAction =
        status === 'waiting_approval'
          ? `等待 ${waitingApprovalCount} 个任务审核`
          : (emp.statusDetail ?? latestTaskTitle.get(emp.id) ?? '');

      const card: DashboardEmployee = {
        employeeId: emp.id,
        name: emp.name,
        role: emp.role,
        status,
        currentAction,
        todayOutput: {
          label: roleLabel.label,
          count: todayByEmployee.get(emp.id) ?? 0,
          unit: roleLabel.unit,
        },
      };
      if (status === 'waiting_approval') {
        card.waitingApprovalCount = waitingApprovalCount;
      }
      return card;
    });
  }

  /** 01 §1.4 高价值客户榜：未删客户 score desc 前 5（FR-04 Top N，无分数阈值，scope 裁剪） */
  private async highValueCustomers(
    tx: Tx,
    scopeCtx: OrgScopeContext,
  ): Promise<DashboardHighValueCustomer[]> {
    const rows = await tx
      .select({
        customerId: schema.customer.id,
        companyName: schema.customer.companyName,
        score: schema.customer.score,
        country: schema.customer.country,
      })
      .from(schema.customer)
      .where(
        scopeAnd(
          notDeleted(schema.customer.deletedAt),
          applyOwnerScope(schema.customer.ownerId, scopeCtx),
          sql`${schema.customer.score} is not null`,
        ),
      )
      .orderBy(desc(schema.customer.score))
      .limit(5);

    return rows.map((r) => ({
      customerId: r.customerId,
      companyName: r.companyName,
      score: Number(r.score),
      ...(r.country ? { country: r.country } : {}),
    }));
  }

  /** 01 §1.5 今日待处理（D2 全量四类：quote_approval/high_value_overdue/customer_reply/order_delay_risk） */
  private async pendingItems(
    tx: Tx,
    scopeCtx: OrgScopeContext,
    now: Date,
  ): Promise<DashboardPendingItem[]> {
    const items: DashboardPendingItem[] = [];

    // quote_approval（D2，随 09）：待审核报价数 → 跳 09 报价中心「待审核」Tab
    const [quoteApproval] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.quotation)
      .where(
        scopeAnd(
          applyOwnerScope(schema.quotation.ownerId, scopeCtx),
          eq(schema.quotation.status, 'waiting_approval'),
        ),
      );
    items.push({
      type: 'quote_approval',
      count: quoteApproval?.n ?? 0,
      level: 'danger',
      link: '/quotes?status=waiting_approval',
    });

    // high_value_overdue：score≥85 且近 7 天无 customer_activity 的客户数（scope 裁剪）
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
    const [overdue] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.customer)
      .where(
        scopeAnd(
          notDeleted(schema.customer.deletedAt),
          applyOwnerScope(schema.customer.ownerId, scopeCtx),
          sql`${schema.customer.score} >= 85`,
          sql`not exists (
            select 1 from ${schema.customerActivity}
            where ${schema.customerActivity.customerId} = ${schema.customer.id}
              and ${schema.customerActivity.createdAt} >= ${sevenDaysAgo}
          )`,
        ),
      );
    items.push({
      type: 'high_value_overdue',
      count: overdue?.n ?? 0,
      level: 'warning',
      link: '/crm?overdue=7d',
    });

    // customer_reply：有未读消息（unreadCount>0）的会话数（scope 经 customer.ownerId 注入）
    const [reply] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.conversation)
      .innerJoin(schema.customer, eq(schema.customer.id, schema.conversation.customerId))
      .where(
        scopeAnd(
          notDeleted(schema.customer.deletedAt),
          applyOwnerScope(schema.customer.ownerId, scopeCtx),
          sql`${schema.conversation.unreadCount} > 0`,
        ),
      );
    items.push({
      type: 'customer_reply',
      count: reply?.n ?? 0,
      level: 'warning',
      link: '/inbox?unread=true',
    });

    // order_delay_risk（D2，随 10）：延期风险订单数（risk='at_risk'）→ 跳 10 订单中心风险筛选
    const [delayRisk] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.salesOrder)
      .where(
        scopeAnd(
          applyOwnerScope(schema.salesOrder.ownerId, scopeCtx),
          eq(schema.salesOrder.risk, 'at_risk'),
        ),
      );
    items.push({
      type: 'order_delay_risk',
      count: delayRisk?.n ?? 0,
      level: 'warning',
      link: '/orders?risk=at_risk',
    });

    return items;
  }

  private async orgTimeZone(tx: Tx, orgId: string): Promise<string> {
    const [orgRow] = await tx
      .select({ timezone: schema.org.timezone })
      .from(schema.org)
      .where(eq(schema.org.id, orgId))
      .limit(1);
    return orgRow?.timezone ?? 'Asia/Shanghai';
  }
}

/** org 时区当地日历日的 00:00 → UTC（「今日」KPI / 今日产出口径，07 §4 同口径） */
function localDayStartUtc(now: Date, timeZone: string): Date {
  const wall = getZonedWallTime(now, timeZone);
  return zonedWallTimeToUtc(
    { year: wall.year, month: wall.month, day: wall.day, hour: 0, minute: 0, second: 0 },
    timeZone,
  );
}
