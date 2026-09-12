/**
 * M5-D2 01 Dashboard 工作台聚合接口集成测试（后端开发计划表 D2）：
 * - GET /dashboard/summary 首屏聚合：greeting / kpis / aiEmployees / highValueCustomers / pendingItems；
 * - P0 降级（00 §5.1 D1~D3）：kpis 仅 new_customers/new_inquiries（D1）、
 *   pendingItems 仅 high_value_overdue/customer_reply（D2）、dailyReport 字段不返回（D3）；
 * - kpis 环比基准 vs_yesterday：今日当地日历日 vs 昨日当地日历日（org.timezone 口径）；
 *   new_customers/new_inquiries 计数与降级断言、aiEmployees 卡片聚合（状态/currentAction/今日产出）；
 * - highValueCustomers：FR-04 Top N（score desc 前 5，无分数阈值，scope 裁剪）；
 * - high_value_overdue：ER 04 超期口径——score≥85 且近 7 天无 customer_activity；
 * - pendingItems 顺序与 level 对齐 FE mock：high_value_overdue → customer_reply，均 warning；
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
import type { DashboardSummary } from '../src/dashboard/dashboard.dto.js';

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
  dashboard = new DashboardService(appDb);

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
    { id: cusTodayAdmin, orgId, companyName: '今日客户·Admin', country: 'US', ownerId: adminId, createdAt: todayStart },
    { id: cusTodayA2, orgId, companyName: '今日客户·A2', country: 'CA', ownerId: adminId, createdAt: todayStart },
    { id: cusTodayA3, orgId, companyName: '今日客户·A3', country: 'AU', ownerId: adminId, createdAt: todayStart },
    { id: cusTodaySales, orgId, companyName: '今日客户·Sales', country: 'JP', ownerId: salesId, createdAt: todayStart },
    { id: cusYesterday, orgId, companyName: '昨日客户', country: 'DE', ownerId: adminId, createdAt: yesterdayStart },
    { id: cusHigh, orgId, companyName: '高价值客户 A', country: 'US', score: 90, ownerId: adminId, createdAt: longAgo },
    { id: cusSalesHigh, orgId, companyName: '高价值客户·Sales', country: 'FR', score: 95, ownerId: salesId, createdAt: longAgo },
    { id: cusHighDone, orgId, companyName: '高价值客户 B', country: 'UK', score: 88, ownerId: adminId, createdAt: longAgo },
    { id: cusLowScore, orgId, companyName: '低分客户', country: 'CN', score: 80, ownerId: adminId, createdAt: longAgo },
    { id: cusScore70, orgId, companyName: '临界客户', country: 'MX', score: 70, ownerId: adminId, createdAt: longAgo },
    { id: cusScoredLow, orgId, companyName: '垫底客户', country: 'BR', score: 50, ownerId: adminId, createdAt: longAgo },
  ]);

  // ===== 会话 seed（今日 2 条 admin 含 1 条未读；昨日 1 条未读归属 sales） =====
  const convUnread = createId('conv');
  const convRead = createId('conv');
  const convOld = createId('conv');
  await superDb.insert(schema.conversation).values([
    { id: convUnread, orgId, customerId: cusTodayAdmin, subject: 'Re: RFQ brackets', priority: 'high', unreadCount: 3, createdAt: todayStart },
    { id: convRead, orgId, customerId: cusTodayAdmin, subject: 'Greetings', priority: 'normal', unreadCount: 0, createdAt: todayStart },
    { id: convOld, orgId, customerId: cusTodaySales, subject: 'Hello from Japan', priority: 'normal', unreadCount: 1, createdAt: yesterdayStart },
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
}, 30_000);

afterAll(async () => {
  if (orgId) {
    await superDb.transaction(async (tx) => {
      await tx.delete(schema.notification).where(eq(schema.notification.orgId, orgId));
      await tx.delete(schema.notificationSetting).where(eq(schema.notificationSetting.orgId, orgId));
      await tx.delete(schema.llmCall).where(eq(schema.llmCall.orgId, orgId));
      await tx.delete(schema.approvalLog).where(eq(schema.approvalLog.orgId, orgId));
      await tx.delete(schema.approvalRequest).where(eq(schema.approvalRequest.orgId, orgId));
      await tx.delete(schema.aiTaskLog).where(eq(schema.aiTaskLog.orgId, orgId));
      await tx.delete(schema.aiTaskStep).where(eq(schema.aiTaskStep.orgId, orgId));
      await tx.delete(schema.aiTask).where(eq(schema.aiTask.orgId, orgId));
      await tx.delete(schema.followUpExecution).where(eq(schema.followUpExecution.orgId, orgId));
      await tx.delete(schema.followUpTask).where(eq(schema.followUpTask.orgId, orgId));
      await tx.delete(schema.followUpStrategyStep).where(eq(schema.followUpStrategyStep.orgId, orgId));
      await tx.delete(schema.followUpStrategy).where(eq(schema.followUpStrategy.orgId, orgId));
      await tx.delete(schema.conversationInsight).where(eq(schema.conversationInsight.orgId, orgId));
      await tx.delete(schema.message).where(eq(schema.message.orgId, orgId));
      await tx.delete(schema.conversation).where(eq(schema.conversation.orgId, orgId));
      await tx.delete(schema.customerInsight).where(eq(schema.customerInsight.orgId, orgId));
      await tx.delete(schema.customerActivity).where(eq(schema.customerActivity.orgId, orgId));
      await tx.delete(schema.contact).where(eq(schema.contact.orgId, orgId));
      await tx.update(schema.customer).set({ sourceLeadId: null }).where(eq(schema.customer.orgId, orgId));
      await tx.update(schema.aiLead).set({ convertedCustomerId: null }).where(eq(schema.aiLead.orgId, orgId));
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

  it('kpis：仅 new_customers/new_inquiries（D1 断言，不含 new_quotes/estimated_revenue）', () => {
    expect(summary.kpis.map((k) => k.metric)).toEqual(['new_customers', 'new_inquiries']);
    for (const kpi of summary.kpis) {
      expect(kpi).not.toHaveProperty('currency');
      expect(kpi.comparePeriod).toBe('vs_yesterday');
    }
  });

  it('kpis 数值与环比：new_customers 今日4/前日1 → +300% up；new_inquiries 今日2/前日1 → +100% up', () => {
    const customers = summary.kpis.find((k) => k.metric === 'new_customers')!;
    expect(customers.value).toBe(4);
    expect(customers.changePct).toBe(300);
    expect(customers.trend).toBe('up');

    const inquiries = summary.kpis.find((k) => k.metric === 'new_inquiries')!;
    expect(inquiries.value).toBe(2);
    expect(inquiries.changePct).toBe(100);
    expect(inquiries.trend).toBe('up');
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

  it('pendingItems：仅 high_value_overdue/customer_reply（D2 断言）+ level/link（对齐 FE mock）', () => {
    expect(summary.pendingItems.map((p) => p.type)).toEqual(['high_value_overdue', 'customer_reply']);
    const overdue = summary.pendingItems.find((p) => p.type === 'high_value_overdue')!;
    expect(overdue.count).toBe(1); // 仅 cusHigh（score≥85 且近 7 天无活动）
    expect(overdue.level).toBe('warning');
    expect(overdue.link).toBe('/crm?overdue=7d');

    const reply = summary.pendingItems.find((p) => p.type === 'customer_reply')!;
    expect(reply.count).toBe(2); // convUnread + convOld
    expect(reply.level).toBe('warning');
    expect(reply.link).toBe('/inbox?unread=true');
  });

  it('dailyReport 字段不返回（D3 断言）', () => {
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
    expect(summary.kpis.map((k) => k.metric)).toEqual(['new_customers', 'new_inquiries']);
    const customers = summary.kpis.find((k) => k.metric === 'new_customers')!;
    expect(customers.value).toBe(1);
    expect(customers.changePct).toBe(0);
    expect(customers.trend).toBe('flat');

    const inquiries = summary.kpis.find((k) => k.metric === 'new_inquiries')!;
    expect(inquiries.value).toBe(0);
    expect(inquiries.changePct).toBe(-100);
    expect(inquiries.trend).toBe('down');
  });

  it('highValueCustomers 仅自己的客户（cusSalesHigh=95）', () => {
    expect(summary.highValueCustomers.map((c) => c.customerId)).toEqual([cusSalesHigh]);
  });

  it('pendingItems 按 owner 裁剪：high_value_overdue=0（·Sales 有活动豁免）、customer_reply=1', () => {
    const overdue = summary.pendingItems.find((p) => p.type === 'high_value_overdue')!;
    expect(overdue.count).toBe(0);
    const reply = summary.pendingItems.find((p) => p.type === 'customer_reply')!;
    expect(reply.count).toBe(1);
  });
});
