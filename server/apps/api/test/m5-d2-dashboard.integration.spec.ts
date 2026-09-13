/**
 * M5-D2 01 Dashboard 工作台聚合接口集成测试（后端开发计划表 D2）：
 * - GET /dashboard/summary 首屏聚合：greeting / kpis / aiEmployees / highValueCustomers / pendingItems；
 * - D1/D2 随 09/10 恢复全量：kpis 含 new_quotes/estimated_revenue、pendingItems 含
 *   quote_approval/order_delay_risk（顺序对齐 01 §2 原型：报价待审核 → 高价值超期 → 客户新回复 → 订单延期风险）；
 * - D3：GET/POST /dashboard/daily-report 委托 13 经营报告（本用例用 ManagerStub 断言委托契约与 40401 语义，
 *   报告生成/五段 Markdown 由 13 自身用例覆盖）；
 * - kpis 环比基准 vs_yesterday：今日当地日历日 vs 昨日当地日历日（org.timezone 口径）；
 *   new_customers/new_inquiries/new_quotes 计数、estimated_revenue 金额（coalesce(won_at, sent_at) 落窗）与环比；
 * - highValueCustomers：FR-04 Top N（score desc 前 5，无分数阈值，scope 裁剪）；
 * - high_value_overdue：ER 04 超期口径——score≥85 且近 7 天无 customer_activity；
 * - scope=self（sales）时 highValueCustomers/kpis/pendingItems 按 owner 裁剪；
 * - greeting.onlineEmployeeCount 口径（working/waiting_approval，01 §1.1）。
 * 前置：docker compose up（PG 5432 / Redis 6379）+ 迁移已执行。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { createId, getZonedWallTime, zonedWallTimeToUtc } from '@tradepilot/core';
import { closeDb, createDb, schema, type Db, type OrgScopeContext } from '@tradepilot/db';
import { EnvService } from '../src/config/env.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { TokenService } from '../src/auth/token.service.js';
import { DashboardService } from '../src/dashboard/dashboard.service.js';
import type { ManagerService } from '../src/manager/manager.service.js';
import type { DashboardSummary } from '../src/dashboard/dashboard.dto.js';

/**
 * 13 ManagerService 最小替身：Dashboard D3 只做委托（listReports → getReport / generateReport），
 * 故此处仅断言委托契约与响应映射；报告生成与五段 Markdown 由 13 经营报告用例覆盖。
 */
class ManagerStub {
  reports: { reportId: string }[] = [];
  detail: Record<string, unknown> | null = null;
  generateCalls: string[] = [];

  async listReports() {
    return { items: this.reports, total: this.reports.length, page: 1, pageSize: 1 };
  }

  async getReport(_ctx: OrgScopeContext, reportId: string) {
    return { reportId, ...(this.detail ?? {}) };
  }

  async generateReport(_ctx: OrgScopeContext, dto: { period: string }) {
    this.generateCalls.push(dto.period);
    return {
      taskId: 'tsk_daily_report',
      reportId: 'rpt_daily_report',
      status: 'generating',
      period: dto.period,
    };
  }
}

const managerStub = new ManagerStub();

process.env.JWT_SECRET ||= 'it_only_test_secret_0123456789abcdef0123456789abcdef';
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.DATABASE_URL ||= 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';

const SUPER_URL = 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';
const APP_URL = 'postgresql://tradepilot_app:changeme_app@localhost:5432/tradepilot';

let superDb: Db;
let appDb: Db;
let redis: Redis;
let dashboard: DashboardService;

let orgId = '';
let adminId = '';
let salesId = '';
let adminCtx: OrgScopeContext;
let salesCtx: OrgScopeContext;

// 员工 fixture id
let empWorking = '';
let empWaiting = '';
let empIdle = '';
let empFailed = '';
let empDone = '';
// 客户 fixture id
let cusTodayAdmin = '';
let cusTodayA2 = '';
let cusTodayA3 = '';
let cusTodaySales = '';
let cusYesterday = '';
let cusHigh = '';
let cusSalesHigh = '';
let cusHighDone = '';
let cusLowScore = '';
let cusScore70 = '';
let cusScoredLow = '';
// 报价 / 订单 fixture id（D1/D2）
let quoteWaiting = '';
let quoteWaitingSales = '';
let quoteSentToday = '';
let quoteWonToday = '';
let quoteDraftTodaySales = '';
let quoteSentYesterday = '';

const adminEmail = `it-m5d2-${createId('org')}@test.com`;
const salesEmail = `it-m5d2-sales-${createId('org')}@test.com`;

/** org.timezone 当地日历日 00:00 → UTC（与 dashboard.service localDayStartUtc 同口径） */
function localDayStartUtc(date: Date, timeZone: string): Date {
  const wall = getZonedWallTime(date, timeZone);
  return zonedWallTimeToUtc(
    { year: wall.year, month: wall.month, day: wall.day, hour: 0, minute: 0, second: 0 },
    timeZone,
  );
}

beforeAll(async () => {
  superDb = createDb(SUPER_URL, { max: 2 });
  appDb = createDb(APP_URL, { max: 5 });
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
  const env = new EnvService();
  const tokens = new TokenService(env, redis);
  const auth = new AuthService(appDb, tokens, redis);

  const session = await auth.register({
    companyName: 'IT M5 D2 租户',
    contactName: '管理员',
    email: adminEmail,
    password: 'password123',
  });
  orgId = session.user.orgId;
  adminId = session.user.userId;

  // sales 成员 fixture（不经邀请链路；仅做角色/数据范围断言）
  salesId = createId('usr');
  await superDb.insert(schema.userAccount).values({
    id: salesId,
    orgId,
    email: salesEmail,
    passwordHash: 'fixture_no_login',
    name: '销售甲',
    role: 'sales',
    status: 'active',
  });

  adminCtx = { orgId, userId: adminId, role: 'admin', scope: 'all' };
  salesCtx = { orgId, userId: salesId, role: 'sales', scope: 'self' };
  dashboard = new DashboardService(appDb, managerStub as unknown as ManagerService);

  // ===== 时间锚点：以 org.timezone 当地日历日为基准，KPI 开窗不依赖跑测时刻 =====
  const [orgRow] = await superDb
    .select({ timezone: schema.org.timezone })
    .from(schema.org)
    .where(eq(schema.org.id, orgId))
    .limit(1);
  const timeZone = orgRow?.timezone ?? 'Asia/Shanghai';
  const todayStart = localDayStartUtc(new Date(), timeZone);
  const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);
  const longAgo = new Date(todayStart.getTime() - 30 * 86_400_000);
  const now = new Date();

  // ===== 员工 seed（register 已预置 6 名 idle 员工，另加 5 名覆盖各状态） =====
  empWorking = createId('emp');
  empWaiting = createId('emp');
  empIdle = createId('emp');
  empFailed = createId('emp');
  empDone = createId('emp');
  await superDb.insert(schema.aiEmployee).values([
    {
      id: empWorking,
      orgId,
      role: 'lead_hunter',
      name: 'IT 获客员工',
      status: 'working',
      goal: '发现客户',
      tools: [],
      permissions: {},
      approvalPolicy: { email_send: 'high_value_only', quote: 'always', autoExecute: [] },
      kpiConfig: { metric: 'daily_leads', target: 35, period: 'daily' },
    },
    {
      id: empWaiting,
      orgId,
      role: 'follow_up',
      name: 'IT 跟进员工',
      status: 'waiting_approval',
      goal: '执行跟进',
      tools: [],
      permissions: {},
      approvalPolicy: { email_send: 'high_value_only', quote: 'always', autoExecute: [] },
      kpiConfig: { metric: 'followup_completion', target: 95, period: 'daily' },
    },
    {
      id: empIdle,
      orgId,
      role: 'merchandiser',
      name: 'IT 跟单员工',
      status: 'idle',
      statusDetail: '暂无订单跟进任务（D4 占位）',
      goal: '订单跟单',
      tools: [],
      permissions: {},
      approvalPolicy: { email_send: 'high_value_only', quote: 'always', autoExecute: [] },
      kpiConfig: { metric: 'risk_alert_timeliness', target: 99, period: 'daily' },
    },
    {
      id: empFailed,
      orgId,
      role: 'sales',
      name: 'IT 销售员工',
      status: 'failed',
      goal: '回复询盘',
      tools: [],
      permissions: {},
      approvalPolicy: { email_send: 'high_value_only', quote: 'always', autoExecute: [] },
      kpiConfig: { metric: 'reply_rate', target: 90, period: 'daily' },
    },
    {
      id: empDone,
      orgId,
      role: 'customer_researcher',
      name: 'IT 研究员',
      status: 'idle',
      goal: '客户分析',
      tools: [],
      permissions: {},
      approvalPolicy: { email_send: 'high_value_only', quote: 'always', autoExecute: [] },
      kpiConfig: { metric: 'daily_insights', target: 20, period: 'daily' },
    },
  ]);

  // empWorking：一条 running 任务 → currentAction 取任务 title（createdAt=todayStart → 今日产出 1）
  await superDb.insert(schema.aiTask).values({
    id: createId('task'),
    orgId,
    employeeId: empWorking,
    type: 'lead_hunting',
    title: '正在寻找美国跑鞋品牌',
    status: 'running',
    createdAt: todayStart,
    startedAt: now,
  });

  // empWaiting：2 条 waiting_approval 任务 → waitingApprovalCount=2
  await superDb.insert(schema.aiTask).values([
    {
      id: createId('task'),
      orgId,
      employeeId: empWaiting,
      type: 'follow_up',
      title: '跟进 ABC Sports 第 3 次',
      status: 'waiting_approval',
      createdAt: todayStart,
    },
    {
      id: createId('task'),
      orgId,
      employeeId: empWaiting,
      type: 'follow_up',
      title: '跟进 Nordic Gear 第 2 次',
      status: 'waiting_approval',
      createdAt: todayStart,
    },
  ]);

  // empDone：今日 2 条 completed 任务 → todayOutput.count=2
  await superDb.insert(schema.aiTask).values([
    {
      id: createId('task'),
      orgId,
      employeeId: empDone,
      type: 'product_analysis',
      title: '分析客户 A',
      status: 'completed',
      createdAt: todayStart,
      finishedAt: now,
    },
    {
      id: createId('task'),
      orgId,
      employeeId: empDone,
      type: 'product_analysis',
      title: '分析客户 B',
      status: 'completed',
      createdAt: todayStart,
      finishedAt: now,
    },
  ]);

  // ===== 客户 seed =====
  // 计 KPI 的「今日」客户：4 名（admin×3 + sales×1）在 todayStart 落点；
  // cusYesterday 在昨日窗口；高价值榜 6 名（有分）全部落在 30 天前，不污染 KPI 计数。
  cusTodayAdmin = createId('cus');
  cusTodayA2 = createId('cus');
  cusTodayA3 = createId('cus');
  cusTodaySales = createId('cus');
  cusYesterday = createId('cus');
  cusHigh = createId('cus');
  cusSalesHigh = createId('cus');
  cusHighDone = createId('cus');
  cusLowScore = createId('cus');
  cusScore70 = createId('cus');
  cusScoredLow = createId('cus');
  await superDb.insert(schema.customer).values([
    {
      id: cusTodayAdmin,
      orgId,
      companyName: '今日客户·Admin',
      country: 'US',
      ownerId: adminId,
      createdAt: todayStart,
    },
    {
      id: cusTodayA2,
      orgId,
      companyName: '今日客户·A2',
      country: 'CA',
      ownerId: adminId,
      createdAt: todayStart,
    },
    {
      id: cusTodayA3,
      orgId,
      companyName: '今日客户·A3',
      country: 'AU',
      ownerId: adminId,
      createdAt: todayStart,
    },
    {
      id: cusTodaySales,
      orgId,
      companyName: '今日客户·Sales',
      country: 'JP',
      ownerId: salesId,
      createdAt: todayStart,
    },
    {
      id: cusYesterday,
      orgId,
      companyName: '昨日客户',
      country: 'DE',
      ownerId: adminId,
      createdAt: yesterdayStart,
    },
    {
      id: cusHigh,
      orgId,
      companyName: '高价值客户 A',
      country: 'US',
      score: 90,
      ownerId: adminId,
      createdAt: longAgo,
    },
    {
      id: cusSalesHigh,
      orgId,
      companyName: '高价值客户·Sales',
      country: 'FR',
      score: 95,
      ownerId: salesId,
      createdAt: longAgo,
    },
    {
      id: cusHighDone,
      orgId,
      companyName: '高价值客户 B',
      country: 'UK',
      score: 88,
      ownerId: adminId,
      createdAt: longAgo,
    },
    {
      id: cusLowScore,
      orgId,
      companyName: '低分客户',
      country: 'CN',
      score: 80,
      ownerId: adminId,
      createdAt: longAgo,
    },
    {
      id: cusScore70,
      orgId,
      companyName: '临界客户',
      country: 'MX',
      score: 70,
      ownerId: adminId,
      createdAt: longAgo,
    },
    {
      id: cusScoredLow,
      orgId,
      companyName: '垫底客户',
      country: 'BR',
      score: 50,
      ownerId: adminId,
      createdAt: longAgo,
    },
  ]);

  // ===== 会话 seed（今日 2 条 admin 含 1 条未读；昨日 1 条未读归属 sales） =====
  const convUnread = createId('conv');
  const convRead = createId('conv');
  const convOld = createId('conv');
  await superDb.insert(schema.conversation).values([
    {
      id: convUnread,
      orgId,
      customerId: cusTodayAdmin,
      subject: 'Re: RFQ brackets',
      priority: 'high',
      unreadCount: 3,
      createdAt: todayStart,
    },
    {
      id: convRead,
      orgId,
      customerId: cusTodayAdmin,
      subject: 'Greetings',
      priority: 'normal',
      unreadCount: 0,
      createdAt: todayStart,
    },
    {
      id: convOld,
      orgId,
      customerId: cusTodaySales,
      subject: 'Hello from Japan',
      priority: 'normal',
      unreadCount: 1,
      createdAt: yesterdayStart,
    },
  ]);

  // ===== 客户活动 seed：高价值客户 B / ·Sales 近 7 天有活动（豁免 overdue），客户 A 无活动（命中） =====
  await superDb.insert(schema.customerActivity).values([
    {
      id: createId('act'),
      orgId,
      customerId: cusHighDone,
      type: 'follow_up',
      summary: '跟进触达记录',
      operatorType: 'user',
      operatorId: adminId,
      createdAt: new Date(now.getTime() - 1 * 86_400_000),
    },
    {
      id: createId('act'),
      orgId,
      customerId: cusSalesHigh,
      type: 'email',
      summary: '邮件往来记录',
      operatorType: 'user',
      operatorId: salesId,
      createdAt: new Date(now.getTime() - 2 * 86_400_000),
    },
  ]);

  // ===== 报价 seed（D1 new_quotes/estimated_revenue 与 D2 quote_approval）=====
  // 今日：waiting_approval×1（admin）+ sent×1（admin）+ won×1（admin）+ draft×1（sales）
  // 昨日：sent×1（admin）；另 waiting_approval×1（sales，createdAt 远期不污染计数）
  quoteWaiting = createId('quo');
  quoteWaitingSales = createId('quo');
  quoteSentToday = createId('quo');
  quoteWonToday = createId('quo');
  quoteDraftTodaySales = createId('quo');
  quoteSentYesterday = createId('quo');
  const quoteBase = {
    orgId,
    incoterms: 'FOB',
    validUntil: '2026-12-31',
    exchangeRate: '1.00000000',
    exchangeRateDate: '2026-09-13',
    exchangeRateSource: 'manual',
    paymentTerms: 'T/T 30%',
  };
  await superDb.insert(schema.quotation).values([
    {
      ...quoteBase,
      id: quoteWaiting,
      quoteNo: `QT-IT-${createId('n')}`,
      customerId: cusTodayAdmin,
      currency: 'USD',
      totalAmount: '500.00',
      status: 'waiting_approval',
      ownerId: adminId,
      createdAt: todayStart,
    },
    {
      ...quoteBase,
      id: quoteSentToday,
      quoteNo: `QT-IT-${createId('n')}`,
      customerId: cusTodayAdmin,
      currency: 'USD',
      totalAmount: '1500.00',
      status: 'sent',
      sentAt: new Date(todayStart.getTime() + 3600_000),
      ownerId: adminId,
      createdAt: todayStart,
    },
    {
      ...quoteBase,
      id: quoteWonToday,
      quoteNo: `QT-IT-${createId('n')}`,
      customerId: cusTodayA2,
      currency: 'USD',
      totalAmount: '500.00',
      status: 'won',
      sentAt: new Date(todayStart.getTime() + 1800_000),
      wonAt: new Date(todayStart.getTime() + 7200_000),
      ownerId: adminId,
      createdAt: todayStart,
    },
    {
      ...quoteBase,
      id: quoteDraftTodaySales,
      quoteNo: `QT-IT-${createId('n')}`,
      customerId: cusTodaySales,
      currency: 'USD',
      totalAmount: '100.00',
      status: 'draft',
      ownerId: salesId,
      createdAt: todayStart,
    },
    {
      ...quoteBase,
      id: quoteSentYesterday,
      quoteNo: `QT-IT-${createId('n')}`,
      customerId: cusYesterday,
      currency: 'USD',
      totalAmount: '1000.00',
      status: 'sent',
      sentAt: new Date(yesterdayStart.getTime() + 3600_000),
      ownerId: adminId,
      createdAt: yesterdayStart,
    },
    {
      ...quoteBase,
      id: quoteWaitingSales,
      quoteNo: `QT-IT-${createId('n')}`,
      customerId: cusSalesHigh,
      currency: 'USD',
      totalAmount: '400.00',
      status: 'waiting_approval',
      ownerId: salesId,
      createdAt: longAgo,
    },
  ]);

  // ===== 订单 seed（D2 order_delay_risk：admin 2 条风险 + sales 1 条 = 全量 3 条）=====
  await superDb.insert(schema.salesOrder).values([
    {
      id: createId('ord'),
      orgId,
      orderNo: `SO-IT-${createId('n')}`,
      customerId: cusTodayAdmin,
      deliveryDate: '2026-10-31',
      amount: '800.00',
      currency: 'USD',
      status: 'in_production',
      risk: 'at_risk',
      ownerId: adminId,
      createdAt: todayStart,
    },
    {
      id: createId('ord'),
      orgId,
      orderNo: `SO-IT-${createId('n')}`,
      customerId: cusTodayA2,
      deliveryDate: '2026-11-30',
      amount: '600.00',
      currency: 'USD',
      status: 'pending_payment',
      risk: 'at_risk',
      ownerId: adminId,
      createdAt: longAgo,
    },
    {
      id: createId('ord'),
      orgId,
      orderNo: `SO-IT-${createId('n')}`,
      customerId: cusTodaySales,
      deliveryDate: '2026-12-15',
      amount: '300.00',
      currency: 'USD',
      status: 'ready_to_ship',
      risk: 'at_risk',
      ownerId: salesId,
      createdAt: longAgo,
    },
    {
      id: createId('ord'),
      orgId,
      orderNo: `SO-IT-${createId('n')}`,
      customerId: cusYesterday,
      deliveryDate: '2026-12-31',
      amount: '900.00',
      currency: 'USD',
      status: 'completed',
      risk: 'normal',
      ownerId: adminId,
      createdAt: longAgo,
    },
  ]);
}, 30_000);

afterAll(async () => {
  if (orgId) {
    await superDb.transaction(async (tx) => {
      await tx.delete(schema.notification).where(eq(schema.notification.orgId, orgId));
      await tx
        .delete(schema.notificationSetting)
        .where(eq(schema.notificationSetting.orgId, orgId));
      await tx.delete(schema.llmCall).where(eq(schema.llmCall.orgId, orgId));
      await tx.delete(schema.approvalLog).where(eq(schema.approvalLog.orgId, orgId));
      await tx.delete(schema.approvalRequest).where(eq(schema.approvalRequest.orgId, orgId));
      await tx.delete(schema.aiTaskLog).where(eq(schema.aiTaskLog.orgId, orgId));
      await tx.delete(schema.aiTaskStep).where(eq(schema.aiTaskStep.orgId, orgId));
      await tx.delete(schema.aiTask).where(eq(schema.aiTask.orgId, orgId));
      await tx.delete(schema.followUpExecution).where(eq(schema.followUpExecution.orgId, orgId));
      await tx.delete(schema.followUpTask).where(eq(schema.followUpTask.orgId, orgId));
      await tx
        .delete(schema.followUpStrategyStep)
        .where(eq(schema.followUpStrategyStep.orgId, orgId));
      await tx.delete(schema.followUpStrategy).where(eq(schema.followUpStrategy.orgId, orgId));
      await tx
        .delete(schema.conversationInsight)
        .where(eq(schema.conversationInsight.orgId, orgId));
      await tx.delete(schema.message).where(eq(schema.message.orgId, orgId));
      await tx.delete(schema.conversation).where(eq(schema.conversation.orgId, orgId));
      // 报价 / 订单（先删订单：sales_order.quotation_id → quotation）
      await tx.delete(schema.salesOrder).where(eq(schema.salesOrder.orgId, orgId));
      await tx.delete(schema.quotation).where(eq(schema.quotation.orgId, orgId));
      await tx.delete(schema.customerInsight).where(eq(schema.customerInsight.orgId, orgId));
      await tx.delete(schema.customerActivity).where(eq(schema.customerActivity.orgId, orgId));
      await tx.delete(schema.contact).where(eq(schema.contact.orgId, orgId));
      await tx
        .update(schema.customer)
        .set({ sourceLeadId: null })
        .where(eq(schema.customer.orgId, orgId));
      await tx
        .update(schema.aiLead)
        .set({ convertedCustomerId: null })
        .where(eq(schema.aiLead.orgId, orgId));
      await tx.delete(schema.aiLeadContact).where(eq(schema.aiLeadContact.orgId, orgId));
      await tx.delete(schema.aiLead).where(eq(schema.aiLead.orgId, orgId));
      await tx.delete(schema.customer).where(eq(schema.customer.orgId, orgId));
      await tx.delete(schema.aiEmployee).where(eq(schema.aiEmployee.orgId, orgId));
      await tx.delete(schema.sopTemplate).where(eq(schema.sopTemplate.orgId, orgId));
      await tx.delete(schema.aiModelSetting).where(eq(schema.aiModelSetting.orgId, orgId));
      await tx.delete(schema.rolePermission).where(eq(schema.rolePermission.orgId, orgId));
      await tx.delete(schema.userAccount).where(eq(schema.userAccount.orgId, orgId));
      await tx.delete(schema.org).where(eq(schema.org.id, orgId));
    });
  }
  await redis.quit();
  await closeDb(appDb);
  await closeDb(superDb);
});

// ============================== D2-1 首屏聚合（admin/all） ==============================

describe('M5-D2 · GET /dashboard/summary（admin · scope=all）', () => {
  let summary: DashboardSummary;

  beforeAll(async () => {
    summary = await dashboard.summary(adminCtx, {});
  });

  it('greeting：onlineEmployeeCount=working+waiting_approval（2），total=全量（6 预置+5 注入=11）', () => {
    expect(summary.greeting).toEqual({ onlineEmployeeCount: 2, onlineEmployeeTotal: 11 });
  });

  it('kpis：D1 全量 4 项且顺序对齐原型（new_customers → new_inquiries → new_quotes → estimated_revenue）', () => {
    expect(summary.kpis.map((k) => k.metric)).toEqual([
      'new_customers',
      'new_inquiries',
      'new_quotes',
      'estimated_revenue',
    ]);
    for (const kpi of summary.kpis) {
      expect(kpi.comparePeriod).toBe('vs_yesterday');
      // 仅金额类 KPI 携带 currency（计数类不返回）
      if (kpi.metric === 'estimated_revenue') {
        expect(kpi.currency).toBe('USD');
        expect(typeof kpi.value).toBe('string');
      } else {
        expect(kpi).not.toHaveProperty('currency');
        expect(typeof kpi.value).toBe('number');
      }
    }
  });

  it('kpis 数值与环比：new_customers 今日4/前日1 → +300%；new_inquiries 今日2/前日1 → +100%', () => {
    const customers = summary.kpis.find((k) => k.metric === 'new_customers')!;
    expect(customers.value).toBe(4);
    expect(customers.changePct).toBe(300);
    expect(customers.trend).toBe('up');

    const inquiries = summary.kpis.find((k) => k.metric === 'new_inquiries')!;
    expect(inquiries.value).toBe(2);
    expect(inquiries.changePct).toBe(100);
    expect(inquiries.trend).toBe('up');
  });

  it('kpis（D1）：new_quotes 今日4/昨日1 → +300%；estimated_revenue 今日2000.00/昨日1000.00 → +100%', () => {
    const quotes = summary.kpis.find((k) => k.metric === 'new_quotes')!;
    expect(quotes.value).toBe(4); // 今日创建的 4 条（waiting_approval/sent/won + sales draft，scope=all）
    expect(quotes.changePct).toBe(300);
    expect(quotes.trend).toBe('up');

    // 预计成交额：今日 sent 1500 + won 500（won 按 won_at 计一次，不重复计 sent_at）
    const revenue = summary.kpis.find((k) => k.metric === 'estimated_revenue')!;
    expect(revenue.value).toBe('2000.00');
    expect(revenue.currency).toBe('USD');
    expect(revenue.changePct).toBe(100);
    expect(revenue.trend).toBe('up');
  });

  it('aiEmployees：working/等待审核/占位/failed 状态映射 + currentAction + 今日产出', () => {
    const byId = new Map(summary.aiEmployees.map((e) => [e.employeeId, e]));
    const working = byId.get(empWorking)!;
    expect(working.status).toBe('working');
    expect(working.currentAction).toBe('正在寻找美国跑鞋品牌');

    const waiting = byId.get(empWaiting)!;
    expect(waiting.status).toBe('waiting_approval');
    expect(waiting.waitingApprovalCount).toBe(2);
    expect(waiting.currentAction).toBe('等待 2 个任务审核');

    const idle = byId.get(empIdle)!;
    expect(idle.status).toBe('idle');
    expect(idle.currentAction).toBe('暂无订单跟进任务（D4 占位）');

    const failed = byId.get(empFailed)!;
    expect(failed.status).toBe('error');

    const done = byId.get(empDone)!;
    expect(done.status).toBe('idle');
    expect(done.todayOutput).toEqual({ label: '今日分析客户', count: 2, unit: '个' });
  });

  it('highValueCustomers：score desc 取前 5 + 未删 + scope 裁剪（95→90→88→80→70）', () => {
    expect(summary.highValueCustomers.map((c) => c.customerId)).toEqual([
      cusSalesHigh,
      cusHigh,
      cusHighDone,
      cusLowScore,
      cusScore70,
    ]);
    expect(summary.highValueCustomers.length).toBe(5);
    for (const c of summary.highValueCustomers) {
      expect(c.companyName).toBeTruthy();
      expect(c.country).toBeTruthy();
      expect(typeof c.score).toBe('number');
    }
  });

  it('pendingItems：D2 四类齐备且顺序对齐原型 + level/link', () => {
    expect(summary.pendingItems.map((p) => p.type)).toEqual([
      'quote_approval',
      'high_value_overdue',
      'customer_reply',
      'order_delay_risk',
    ]);

    const approval = summary.pendingItems.find((p) => p.type === 'quote_approval')!;
    expect(approval.count).toBe(2); // admin 1 + sales 1（scope=all）
    expect(approval.level).toBe('danger');
    expect(approval.link).toBe('/quotes?status=waiting_approval');

    const overdue = summary.pendingItems.find((p) => p.type === 'high_value_overdue')!;
    expect(overdue.count).toBe(1); // 仅 cusHigh（score≥85 且近 7 天无活动）
    expect(overdue.level).toBe('warning');
    expect(overdue.link).toBe('/crm?overdue=7d');

    const reply = summary.pendingItems.find((p) => p.type === 'customer_reply')!;
    expect(reply.count).toBe(2); // convUnread + convOld
    expect(reply.level).toBe('warning');
    expect(reply.link).toBe('/inbox?unread=true');

    const delayRisk = summary.pendingItems.find((p) => p.type === 'order_delay_risk')!;
    expect(delayRisk.count).toBe(3); // admin 2 条 + sales 1 条（scope=all）
    expect(delayRisk.level).toBe('warning');
    expect(delayRisk.link).toBe('/orders?risk=at_risk');
  });

  it('dailyReport 字段不内联（D3：报告正文经 /dashboard/daily-report 单独拉取）', () => {
    expect(Object.keys(summary)).not.toContain('dailyReport');
    expect(summary.dailyReport).toBeUndefined();
  });
});

// ============================== D2-2 scope=self（sales）裁剪 ==============================

describe('M5-D2 · GET /dashboard/summary（sales · scope=self）', () => {
  let summary: DashboardSummary;

  beforeAll(async () => {
    summary = await dashboard.summary(salesCtx, {});
  });

  it('kpis 按 owner 裁剪：new_customers=1（无前值 → 0/flat）、new_inquiries 今日0/昨日1 → -100% down', () => {
    expect(summary.kpis.map((k) => k.metric)).toEqual([
      'new_customers',
      'new_inquiries',
      'new_quotes',
      'estimated_revenue',
    ]);
    const customers = summary.kpis.find((k) => k.metric === 'new_customers')!;
    expect(customers.value).toBe(1);
    expect(customers.changePct).toBe(0);
    expect(customers.trend).toBe('flat');

    const inquiries = summary.kpis.find((k) => k.metric === 'new_inquiries')!;
    expect(inquiries.value).toBe(0);
    expect(inquiries.changePct).toBe(-100);
    expect(inquiries.trend).toBe('down');
  });

  it('kpis（D1）按 owner 裁剪：new_quotes=1（仅自己的 draft）、estimated_revenue=0.00（无 sent/won）', () => {
    const quotes = summary.kpis.find((k) => k.metric === 'new_quotes')!;
    expect(quotes.value).toBe(1);
    expect(quotes.trend).toBe('flat');

    const revenue = summary.kpis.find((k) => k.metric === 'estimated_revenue')!;
    expect(revenue.value).toBe('0.00');
    expect(revenue.currency).toBe('USD');
    expect(revenue.trend).toBe('flat');
  });

  it('highValueCustomers 仅自己的客户（cusSalesHigh=95）', () => {
    expect(summary.highValueCustomers.map((c) => c.customerId)).toEqual([cusSalesHigh]);
  });

  it('pendingItems 按 owner 裁剪：quote_approval=1、high_value_overdue=0、customer_reply=1、order_delay_risk=1', () => {
    expect(summary.pendingItems.map((p) => p.type)).toEqual([
      'quote_approval',
      'high_value_overdue',
      'customer_reply',
      'order_delay_risk',
    ]);
    const approval = summary.pendingItems.find((p) => p.type === 'quote_approval')!;
    expect(approval.count).toBe(1); // quoteWaitingSales

    const overdue = summary.pendingItems.find((p) => p.type === 'high_value_overdue')!;
    expect(overdue.count).toBe(0);
    const reply = summary.pendingItems.find((p) => p.type === 'customer_reply')!;
    expect(reply.count).toBe(1);
    const delayRisk = summary.pendingItems.find((p) => p.type === 'order_delay_risk')!;
    expect(delayRisk.count).toBe(1);
  });
});

// ============================== D3 AI 每日报告（随 13 恢复） ==============================

describe('M5-D2 · D3 /dashboard/daily-report（委托 13 经营报告）', () => {
  beforeAll(() => {
    managerStub.reports = [];
    managerStub.detail = null;
    managerStub.generateCalls = [];
  });

  it('无日报：dailyReport 抛 40401（01 §3.2 无报告语义，前端渲染空态 + 生成入口）', async () => {
    managerStub.reports = [];
    await expect(dashboard.dailyReport(adminCtx)).rejects.toThrow('暂无 AI 每日报告');
  });

  it('有日报：取最新一条 daily 报告并映射 reportId/status/content/generatedAt/citations', async () => {
    managerStub.reports = [{ reportId: 'rpt_latest_daily' }];
    managerStub.detail = {
      period: 'daily',
      status: 'ready',
      content: '## 经营概览\n\n本周新增客户 4 家。',
      generatedAt: '2026-09-13T02:00:00.000Z',
      citations: [{ refType: 'customer', refId: cusHigh }],
    };

    const report = await dashboard.dailyReport(adminCtx);
    expect(report.reportId).toBe('rpt_latest_daily');
    expect(report.period).toBe('daily');
    expect(report.status).toBe('ready');
    expect(report.content).toContain('经营概览');
    expect(report.generatedAt).toBe('2026-09-13T02:00:00.000Z');
    expect(report.citations).toEqual([{ refType: 'customer', refId: cusHigh }]);
  });

  it('生成：默认日报 period=daily，返回异步任务 taskId/reportId/status', async () => {
    const result = await dashboard.generateDailyReport(adminCtx, { period: 'daily' });
    expect(managerStub.generateCalls).toEqual(['daily']);
    expect(result).toEqual({
      taskId: 'tsk_daily_report',
      reportId: 'rpt_daily_report',
      status: 'generating',
      period: 'daily',
    });
  });

  it('生成：支持显式 period（周报）透传 13', async () => {
    managerStub.generateCalls = [];
    const result = await dashboard.generateDailyReport(adminCtx, { period: 'weekly' });
    expect(managerStub.generateCalls).toEqual(['weekly']);
    expect(result.period).toBe('weekly');
  });
});
