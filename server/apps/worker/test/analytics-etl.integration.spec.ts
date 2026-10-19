import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import pino from 'pino';
import { createId } from '@tradepilot/core';
import { closeDb, createDb, schema, type Db } from '@tradepilot/db';
import { AnalyticsEtl } from '../src/scheduler/analytics-etl.js';

/**
 * P1-X-40~43 分析预聚合集成测试（产品需求 15 §7 / ER 08 §2.5）：
 * - 按 org 时区回算当地日区间，把业务表区间计数写入 analytics_daily_summary；
 * - 唯一键 (org_id, stat_date, country, employee_id) 幂等 upsert（重复 tick 不增行）；
 * - org 级指标 + 员工级 AI 贡献归因（found/replied/promoted/savedHours）；
 * - promotedInquiries 14 天窗口 + 最后触点归因。
 * 前置：docker compose up（PG 5432）；集成测试连接为 superuser（BYPASSRLS，等效 sched 扫描语义）。
 */

const SUPER_URL =
  process.env.TEST_DB_URL ?? 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';
const logger: Logger = pino({ level: 'silent' });

const ORG = createId('org');
const USER = createId('usr');
const E1 = createId('emp');
const E2 = createId('emp');
const T1 = createId('task');
const T2 = createId('task');
const L1 = createId('lead');
const L2 = createId('lead');
const L3 = createId('lead');
const CU1 = createId('cus');
const CU2 = createId('cus');
const CU3 = createId('cus');
const CU4 = createId('cus');
const C1 = createId('conv');
const C2 = createId('conv');
const C3 = createId('conv');
const OUT1 = createId('msg');
const OUT2 = createId('msg');
const IN1 = createId('msg');
const IN2 = createId('msg');
const IN3 = createId('msg');
const ACT1 = createId('act');
const ACT2 = createId('act');
const Q1 = createId('quote');
const S1 = createId('strat');
const FT1 = createId('ftask');
const FX1 = createId('fexec');

const TZ = 'Asia/Shanghai';
/** 回算基准：当地 2026-06-15 20:00 → 昨日当地日 2026-06-14 */
const NOW = new Date('2026-06-15T12:00:00Z');
const STAT_DATE = '2026-06-14';
/** 落在 [2026-06-13T16:00Z, 2026-06-14T16:00Z) 当地日区间内的种子时点 */
const AT = new Date('2026-06-14T02:00:00Z');
const OUT1_AT = new Date('2026-06-13T18:00:00Z');
const IN2_AT = new Date('2026-06-14T03:00:00Z');
const IN3_AT = new Date('2026-06-14T04:00:00Z');
/** 窗口外（距首条来信 > 14 天）的外联，不应计入 replied_emails / promoted_inquiries */
const OUT2_AT = new Date('2026-05-01T00:00:00Z');

let db: Db;
let etl: AnalyticsEtl;

async function seed(): Promise<void> {
  await db.insert(schema.org).values({ id: ORG, name: '分析预聚合租户', timezone: TZ });
  await db.insert(schema.userAccount).values({
    id: USER,
    orgId: ORG,
    email: `it-ae-${ORG}@test.com`,
    passwordHash: 'x',
    name: '分析测试管理员',
    role: 'admin',
    status: 'active',
  });
  await db.insert(schema.aiEmployee).values([
    {
      id: E1,
      orgId: ORG,
      role: 'sales',
      name: 'AI 销售 1',
      goal: 'g',
      permissions: {},
      approvalPolicy: { email_send: 'always', quote: 'always', autoExecute: [] },
      kpiConfig: { metric: 'saved_hours', target: 0, period: 'daily' },
    },
    {
      id: E2,
      orgId: ORG,
      role: 'follow_up',
      name: 'AI 跟进 1',
      goal: 'g',
      permissions: {},
      approvalPolicy: { email_send: 'always', quote: 'always', autoExecute: [] },
      kpiConfig: { metric: 'saved_hours', target: 0, period: 'daily' },
    },
  ]);
  await db.insert(schema.aiTask).values([
    { id: T1, orgId: ORG, employeeId: E1, type: 'lead_hunting', title: 't1' },
    { id: T2, orgId: ORG, employeeId: E2, type: 'lead_hunting', title: 't2' },
  ]);
  const lead = (id: string, taskId: string, company: string) => ({
    id,
    orgId: ORG,
    taskId,
    companyName: company,
    country: 'DE',
    matchPct: 80,
    scoreLevel: 'high' as const,
    insight: { value: 0.8, confidence: 0.9, reasons: [] },
  });
  await db
    .insert(schema.aiLead)
    .values([lead(L1, T1, 'L1'), lead(L2, T1, 'L2'), lead(L3, T2, 'L3')]);

  // CU1/CU2 归因 E1；CU3 归因 E2；CU4 无获客溯源
  await db.insert(schema.customer).values([
    {
      id: CU1,
      orgId: ORG,
      companyName: 'CU1',
      country: 'DE',
      ownerId: USER,
      sourceLeadId: L1,
      createdAt: AT,
    },
    {
      id: CU2,
      orgId: ORG,
      companyName: 'CU2',
      country: 'DE',
      ownerId: USER,
      sourceLeadId: L2,
      createdAt: AT,
    },
    {
      id: CU3,
      orgId: ORG,
      companyName: 'CU3',
      country: 'FR',
      ownerId: USER,
      sourceLeadId: L3,
      createdAt: AT,
    },
    { id: CU4, orgId: ORG, companyName: 'CU4', country: 'US', ownerId: USER, createdAt: AT },
  ]);
  await db.insert(schema.conversation).values([
    { id: C1, orgId: ORG, customerId: CU1, createdAt: AT },
    { id: C2, orgId: ORG, customerId: CU2, createdAt: AT },
    { id: C3, orgId: ORG, customerId: CU3, createdAt: AT },
  ]);
  const outMsg = (id: string, conv: string, sentAt: Date) => ({
    id,
    orgId: ORG,
    conversationId: conv,
    direction: 'out' as const,
    senderType: 'ai' as const,
    senderName: 'AI',
    content: 'outbound',
    status: 'sent' as const,
    sentAt,
    createdAt: sentAt,
  });
  const inMsg = (id: string, conv: string, at: Date) => ({
    id,
    orgId: ORG,
    conversationId: conv,
    direction: 'in' as const,
    senderType: 'contact' as const,
    senderName: '客户',
    content: 'inbound',
    status: 'sent' as const,
    createdAt: at,
  });
  await db
    .insert(schema.message)
    .values([
      outMsg(OUT1, C1, OUT1_AT),
      outMsg(OUT2, C2, OUT2_AT),
      inMsg(IN1, C1, AT),
      inMsg(IN2, C2, IN2_AT),
      inMsg(IN3, C3, IN3_AT),
    ]);
  // 外联 → AI 员工的归属证据（归因口径依赖 customer_activity.operator_id）
  await db.insert(schema.customerActivity).values([
    {
      id: ACT1,
      orgId: ORG,
      customerId: CU1,
      type: 'email',
      summary: 'AI 外联',
      operatorType: 'ai',
      operatorId: E1,
      refType: 'message',
      refId: OUT1,
    },
    {
      id: ACT2,
      orgId: ORG,
      customerId: CU2,
      type: 'email',
      summary: 'AI 外联',
      operatorType: 'ai',
      operatorId: E2,
      refType: 'message',
      refId: OUT2,
    },
  ]);
  await db.insert(schema.quotation).values({
    id: Q1,
    orgId: ORG,
    quoteNo: 'Q1',
    customerId: CU1,
    currency: 'USD',
    incoterms: 'FOB',
    validUntil: '2026-07-01',
    exchangeRate: '7.2',
    exchangeRateDate: '2026-06-14',
    exchangeRateSource: 'manual',
    paymentTerms: 'TT',
    totalAmount: '1000',
    ownerId: USER,
    createdAt: AT,
  });
  await db.insert(schema.followUpStrategy).values({
    id: S1,
    orgId: ORG,
    name: '默认策略',
    targetScope: {},
    autoSendPolicy: 'auto_send',
  });
  await db
    .insert(schema.followUpTask)
    .values({ id: FT1, orgId: ORG, customerId: CU4, strategyId: S1 });
  await db.insert(schema.followUpExecution).values({
    id: FX1,
    orgId: ORG,
    followUpTaskId: FT1,
    stepTitle: 'step1',
    status: 'sent',
    sentAt: AT,
  });
}

async function loadOrgRows() {
  return db
    .select()
    .from(schema.analyticsDailySummary)
    .where(
      and(
        eq(schema.analyticsDailySummary.orgId, ORG),
        eq(schema.analyticsDailySummary.statDate, STAT_DATE),
      ),
    );
}

beforeAll(async () => {
  db = createDb(SUPER_URL, { max: 5 });
  etl = new AnalyticsEtl({ db, logger, lookbackDays: 1 });

  // 聚合口径依赖 RLS 隔离；测试库连接为 superuser 不生效，故 beforeAll 清空指标源表建立干净基线
  await db.transaction(async (tx) => {
    await tx.execute(sql`TRUNCATE TABLE
      analytics_daily_summary,
      customer_activity, message, conversation,
      follow_up_execution, follow_up_task, follow_up_strategy,
      quotation, customer, ai_lead, ai_task, ai_task_step, ai_task_log, ai_employee
      RESTART IDENTITY CASCADE`);
  });
  await seed();
});

afterAll(async () => {
  await db.delete(schema.analyticsDailySummary).where(eq(schema.analyticsDailySummary.orgId, ORG));
  await closeDb(db);
});

describe('AnalyticsEtl 分析日汇总预聚合（P1-X-40~43）', () => {
  it('按 org 当地日聚合并写入 org 级 / 员工级指标', async () => {
    await etl.tick(NOW);
    const rows = await loadOrgRows();
    const byKey = new Map(rows.map((r) => [`${r.country}|${r.employeeId}`, r]));

    // org 级：区间计数 + savedHours 估算（3 获客*10 + 1 邮件*15 + 1 跟进*5 = 50min → 0.8h）
    const total = byKey.get('ALL|ALL');
    expect(total).toBeDefined();
    expect(total).toMatchObject({
      newCustomers: 4,
      newInquiries: 3,
      newQuotes: 1,
      foundCustomers: 3,
      repliedEmails: 1,
      promotedInquiries: 1,
      savedHours: '0.8',
    });

    // 员工 E1：获客 2 + 邮件 1 + 促成询盘 1（窗口内最后触点）→ (20+15)/60=0.583→0.6
    expect(byKey.get(`ALL|${E1}`)).toMatchObject({
      foundCustomers: 2,
      repliedEmails: 1,
      promotedInquiries: 1,
      savedHours: '0.6',
    });

    // 员工 E2：仅获客 1（其外联在窗口外，不计 replied/promoted）→ 10/60→0.2
    expect(byKey.get(`ALL|${E2}`)).toMatchObject({
      foundCustomers: 1,
      repliedEmails: 0,
      promotedInquiries: 0,
      savedHours: '0.2',
    });
  });

  it('唯一键幂等：重复 tick 不新增行', async () => {
    const before = await loadOrgRows();
    await etl.tick(NOW);
    const after = await loadOrgRows();
    expect(after).toHaveLength(before.length);
    expect(after).toHaveLength(3); // ALL|ALL + ALL|E1 + ALL|E2
  });
});
