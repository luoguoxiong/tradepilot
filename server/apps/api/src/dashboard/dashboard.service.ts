import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import {
  BizException,
  ErrorCode,
  getZonedWallTime,
  zonedWallTimeToUtc,
} from '@tradepilot/core';
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
import type {
  DashboardEmployee,
  DashboardHighValueCustomer,
  DashboardKpi,
  DashboardPendingItem,
  DashboardQuery,
  DashboardSummary,
} from './dashboard.dto.js';

/**
 * 01 Dashboard 工作台服务（接口 01 §3.1，M5-D2）：
 * - greeting：AI 员工在线数（status ∈ working/waiting_approval）与总人数（org 级，不做 owner scope）；
 * - kpis：new_customers / new_inquiries（org.timezone 当地日历「今日」口径，P0 D1 不返回 new_quotes/
 *   estimated_revenue；环比基准 vs_yesterday：前值=昨日当地日历日，前值为 0 时 changePct=0/trend=flat）；
 * - aiEmployees：员工卡片聚合——currentAction 依次取 waiting_approval 的「等待 N 个任务审核」/
 *   statusDetail / 最新 running·waiting_approval 任务 title，todayOutput 按角色文案取今日 ai_task 数
 *   （org 级，不做 owner scope）；
 * - highValueCustomers：未删客户按 score desc 取前 5（FR-04 Top N，无分数阈值，scope 裁剪）；
 * - pendingItems：high_value_overdue（score≥85 且近 7 天无 customer_activity，ER 04 超期口径）与
 *   customer_reply（未读会话，scope 裁剪）；P0 D2 不返回 quote_approval/order_delay_risk；
 * - dailyReport：P0 D3 恒不返回/不开放（13 为 P1，调用 40401）。
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
  constructor(@Inject(DB) private readonly db: Db) {}

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

  /** 01 §3.2 获取最新 AI 每日报告（P0 D3：恒返回 40401） */
  async dailyReport(): Promise<never> {
    throw new BizException(ErrorCode.NOT_FOUND, 'AI 每日报告未启用（P1 开放，D3 降级）');
  }

  /** 01 §3.3 触发生成 AI 每日报告（P0 D3：恒返回 40401） */
  async generateDailyReport(): Promise<never> {
    throw new BizException(ErrorCode.NOT_FOUND, 'AI 每日报告生成未启用（P1 开放，D3 降级）');
  }

  /** 01 §1.1 问候区：在线（working/waiting_approval）与员工总数（org 级，RLS 隔离） */
  private async greeting(tx: Tx): Promise<DashboardSummary['greeting']> {
    const [online] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.aiEmployee)
      .where(inArray(schema.aiEmployee.status, [...ONLINE_EMPLOYEE_STATUSES]));
    const [total] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.aiEmployee);
    return { onlineEmployeeCount: online?.n ?? 0, onlineEmployeeTotal: total?.n ?? 0 };
  }

  /** 01 §1.2 KPI 卡（P0 D1：仅 new_customers/new_inquiries；环比基准 vs_yesterday） */
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

    return [
      toKpi('new_customers', await countCustomers(todayStart), await countCustomers(yesterdayStart, todayStart)),
      toKpi('new_inquiries', await countInquiries(todayStart), await countInquiries(yesterdayStart, todayStart)),
    ];
  }

  /** 01 §1.3 AI 员工卡片（org 级；currentAction 优先 waiting 文案/statusDetail/task title；今日产出按角色文案） */
  private async aiEmployees(tx: Tx, now: Date, timeZone: string): Promise<DashboardEmployee[]> {
    const todayStart = localDayStartUtc(now, timeZone);
    const employees = await tx
      .select()
      .from(schema.aiEmployee)
      .orderBy(asc(schema.aiEmployee.createdAt));

    const result: DashboardEmployee[] = [];
    for (const emp of employees) {
      // 当前动作：该员工最新 running/waiting_approval 任务的 title（working 等展示用）
      const [current] = await tx
        .select({ title: schema.aiTask.title })
        .from(schema.aiTask)
        .where(
          and(
            eq(schema.aiTask.employeeId, emp.id),
            inArray(schema.aiTask.status, ['running', 'waiting_approval']),
          ),
        )
        .orderBy(desc(schema.aiTask.updatedAt))
        .limit(1);

      // 今日产出：该员工今日（org 当地日 00:00 起）创建的 ai_task 数
      const [done] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.aiTask)
        .where(and(eq(schema.aiTask.employeeId, emp.id), gte(schema.aiTask.createdAt, todayStart)));

      // 等待审核任务数
      const [waiting] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.aiTask)
        .where(and(eq(schema.aiTask.employeeId, emp.id), eq(schema.aiTask.status, 'waiting_approval')));

      const status = DASH_STATUS[emp.status] ?? 'idle';
      const waitingApprovalCount = waiting?.n ?? 0;
      const roleLabel = TODAY_OUTPUT_LABEL[emp.role] ?? { label: '今日处理', unit: '个' };
      // currentAction：waiting_approval → 「等待 N 个任务审核」；占位（statusDetail）次之；再退回任务 title
      const currentAction =
        status === 'waiting_approval'
          ? `等待 ${waitingApprovalCount} 个任务审核`
          : (emp.statusDetail ?? current?.title ?? '');

      const card: DashboardEmployee = {
        employeeId: emp.id,
        name: emp.name,
        role: emp.role,
        status,
        currentAction,
        todayOutput: { label: roleLabel.label, count: done?.n ?? 0, unit: roleLabel.unit },
      };
      if (status === 'waiting_approval') {
        card.waitingApprovalCount = waitingApprovalCount;
      }
      result.push(card);
    }
    return result;
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

  /** 01 §1.5 今日待处理（P0 D2：仅 high_value_overdue/customer_reply） */
  private async pendingItems(
    tx: Tx,
    scopeCtx: OrgScopeContext,
    now: Date,
  ): Promise<DashboardPendingItem[]> {
    const items: DashboardPendingItem[] = [];

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
    items.push({ type: 'high_value_overdue', count: overdue?.n ?? 0, level: 'warning', link: '/crm?overdue=7d' });

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
    items.push({ type: 'customer_reply', count: reply?.n ?? 0, level: 'warning', link: '/inbox?unread=true' });

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