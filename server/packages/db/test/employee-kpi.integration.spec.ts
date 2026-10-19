import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createId } from '@tradepilot/core';
import {
  closeDb,
  createDb,
  fetchEmployeeKpiCounts,
  kpiCountOf,
  schema,
  withOrg,
  type Db,
} from '../src/index.js';

/**
 * 02 §3.2 KPI 精化口径（P1-02-04）数据层集成测试。
 * 前置：docker compose up（PG 5432）+ `pnpm migrate` 已执行。
 *
 * 覆盖点：
 * - 6 类指标各自的业务表聚合与时间半开区间 `[start, end)`（边界值 in / out）；
 * - 归因链路：`ai_lead.task_id → ai_task.employee_id`（lead_hunter/researcher）、
 *   `customer_activity.operator_id`（sales）、`business_report.task_id → ai_task.employee_id`（manager）；
 * - 职能指标（follow_up/merchandiser）按 org 统计、无员工也取到值；
 * - 租户隔离：B 租户的同区间数据不影响 A 租户聚合结果。
 *
 * 引导数据用超级用户连接（BYPASSRLS），断言用 tradepilot_app 连接（FORCE RLS 生效）。
 */

const SUPER_URL = 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';
const APP_URL = 'postgresql://tradepilot_app:changeme_app@localhost:5432/tradepilot';

let superDb: Db;
let appDb: Db;

const ORG_A = createId('org');
const ORG_B = createId('org');
const USER_A = createId('usr');
const EMP_A = createId('emp');
const EMP_A_OTHER = createId('emp');
const EMP_B = createId('emp');
const TASK_A = createId('task');
const TASK_B = createId('task');
const CUS_A = createId('cus');
const CUS_B = createId('cus');
const CNV_A = createId('cnv');
const CNV_B = createId('cnv');
const MSG_A = createId('msg');
const MSG_A_IN = createId('msg');
const MSG_A_OLD = createId('msg');
const MSG_B = createId('msg');
const STRATEGY_A = createId('fstrat');
const FUP_TASK_A = createId('fup');
const LEAD_IN = createId('lead');
const LEAD_AT_START = createId('lead');
const LEAD_BEFORE = createId('lead');
const LEAD_AT_END = createId('lead');
const LEAD_B = createId('lead');

/** 统计区间：2026-09-13 当地日（测试内固定 UTC 时区口径，避免依赖运行时区） */
const RANGE = {
  start: new Date('2026-09-13T00:00:00.000Z'),
  end: new Date('2026-09-14T00:00:00.000Z'),
};
const AT_START = new Date('2026-09-13T00:00:00.000Z');
const IN_RANGE = new Date('2026-09-13T10:00:00.000Z');
const BEFORE = new Date('2026-09-12T23:59:00.000Z');

const kpiConfig = { metric: 'daily_leads', target: 10, period: 'daily' as const };
const leadRow = (
  id: string,
  orgId: string,
  taskId: string | null,
  createdAt: Date,
  analyzedAt: Date | null,
) => ({
  id,
  orgId,
  taskId,
  companyName: `Lead ${id}`,
  country: 'DE',
  matchPct: 80,
  scoreLevel: 'high' as const,
  insight: {},
  analyzedAt,
  createdAt,
  updatedAt: createdAt,
});

beforeAll(async () => {
  superDb = createDb(SUPER_URL, { max: 2 });
  appDb = createDb(APP_URL, { max: 2 });

  await superDb.transaction(async (tx) => {
    await tx.insert(schema.org).values([
      { id: ORG_A, name: 'KPI租户A' },
      { id: ORG_B, name: 'KPI租户B' },
    ]);
    await tx.insert(schema.userAccount).values({
      id: USER_A,
      orgId: ORG_A,
      email: `kpi-${ORG_A}@test.com`,
      passwordHash: 'x',
      name: 'A管理员',
      role: 'admin',
      status: 'active',
    });
    await tx.insert(schema.aiEmployee).values([
      {
        id: EMP_A,
        orgId: ORG_A,
        role: 'lead_hunter',
        name: 'A获客员工',
        goal: '找客户',
        permissions: {},
        approvalPolicy: { email_send: 'high_value_only', quote: 'always', autoExecute: [] },
        kpiConfig,
      },
      {
        id: EMP_A_OTHER,
        orgId: ORG_A,
        role: 'follow_up',
        name: 'A跟进员工',
        goal: '跟进',
        permissions: {},
        approvalPolicy: { email_send: 'high_value_only', quote: 'always', autoExecute: [] },
        kpiConfig: { metric: 'daily_followups', target: 5, period: 'daily' },
      },
      {
        id: EMP_B,
        orgId: ORG_B,
        role: 'lead_hunter',
        name: 'B获客员工',
        goal: '找客户',
        permissions: {},
        approvalPolicy: { email_send: 'high_value_only', quote: 'always', autoExecute: [] },
        kpiConfig,
      },
    ]);
    // 员工需有 createdBy=USER_A，故先建任务指向员工（createdAt 固定，避免影响任务计数类断言）
    await tx.insert(schema.aiTask).values([
      {
        id: TASK_A,
        orgId: ORG_A,
        employeeId: EMP_A,
        type: 'lead_hunting',
        title: 'A 获客任务',
        input: {},
      },
      {
        id: TASK_B,
        orgId: ORG_B,
        employeeId: EMP_B,
        type: 'lead_hunting',
        title: 'B 获客任务',
        input: {},
      },
    ]);
    await tx
      .insert(schema.aiLead)
      .values([
        leadRow(LEAD_IN, ORG_A, TASK_A, IN_RANGE, IN_RANGE),
        leadRow(LEAD_AT_START, ORG_A, TASK_A, AT_START, AT_START),
        leadRow(LEAD_BEFORE, ORG_A, TASK_A, BEFORE, BEFORE),
        leadRow(LEAD_AT_END, ORG_A, TASK_A, RANGE.end, null),
        leadRow(LEAD_B, ORG_B, TASK_B, IN_RANGE, IN_RANGE),
      ]);
    await tx.insert(schema.customer).values([
      { id: CUS_A, orgId: ORG_A, companyName: 'A客户', country: 'US', ownerId: USER_A },
      { id: CUS_B, orgId: ORG_B, companyName: 'B客户', country: 'US', ownerId: USER_A },
    ]);
    await tx.insert(schema.conversation).values([
      { id: CNV_A, orgId: ORG_A, customerId: CUS_A, subject: 'A 询盘' },
      { id: CNV_B, orgId: ORG_B, customerId: CUS_B, subject: 'B 询盘' },
    ]);
    await tx.insert(schema.message).values([
      {
        id: MSG_A,
        orgId: ORG_A,
        conversationId: CNV_A,
        direction: 'out',
        senderType: 'ai',
        senderName: 'A获客员工',
        content: '回复',
        status: 'sent',
        sentAt: IN_RANGE,
      },
      {
        id: MSG_A_IN,
        orgId: ORG_A,
        conversationId: CNV_A,
        direction: 'in',
        senderType: 'contact',
        senderName: '客户',
        content: '来信',
        status: 'sent',
        sentAt: IN_RANGE,
      },
      {
        id: MSG_A_OLD,
        orgId: ORG_A,
        conversationId: CNV_A,
        direction: 'out',
        senderType: 'ai',
        senderName: 'A获客员工',
        content: '旧回复',
        status: 'sent',
        sentAt: BEFORE,
      },
      {
        id: MSG_B,
        orgId: ORG_B,
        conversationId: CNV_B,
        direction: 'out',
        senderType: 'ai',
        senderName: 'B获客员工',
        content: '回复',
        status: 'sent',
        sentAt: IN_RANGE,
      },
    ]);
    await tx.insert(schema.customerActivity).values([
      // 归因记录：AI 员工发出（operator_id = emp_）
      {
        id: createId('act'),
        orgId: ORG_A,
        customerId: CUS_A,
        type: 'email',
        summary: 'AI 回复',
        operatorType: 'ai',
        operatorId: EMP_A,
        refType: 'message',
        refId: MSG_A,
        createdAt: IN_RANGE,
      },
      {
        id: createId('act'),
        orgId: ORG_A,
        customerId: CUS_A,
        type: 'email',
        summary: 'AI 旧回复',
        operatorType: 'ai',
        operatorId: EMP_A,
        refType: 'message',
        refId: MSG_A_OLD,
        createdAt: BEFORE,
      },
      {
        id: createId('act'),
        orgId: ORG_B,
        customerId: CUS_B,
        type: 'email',
        summary: 'B AI 回复',
        operatorType: 'ai',
        operatorId: EMP_B,
        refType: 'message',
        refId: MSG_B,
        createdAt: IN_RANGE,
      },
    ]);
    await tx.insert(schema.followUpStrategy).values({
      id: STRATEGY_A,
      orgId: ORG_A,
      name: 'A 跟进策略',
      targetScope: {},
      autoSendPolicy: 'manual_review',
    });
    await tx.insert(schema.followUpTask).values({
      id: FUP_TASK_A,
      orgId: ORG_A,
      customerId: CUS_A,
      strategyId: STRATEGY_A,
    });
    await tx.insert(schema.followUpExecution).values([
      {
        id: createId('fex'),
        orgId: ORG_A,
        followUpTaskId: FUP_TASK_A,
        stepTitle: '第 1 步',
        status: 'sent',
        sentAt: IN_RANGE,
      },
      {
        id: createId('fex'),
        orgId: ORG_A,
        followUpTaskId: FUP_TASK_A,
        stepTitle: '旧步骤',
        status: 'sent',
        sentAt: BEFORE,
      },
      {
        id: createId('fex'),
        orgId: ORG_A,
        followUpTaskId: FUP_TASK_A,
        stepTitle: '跳过步骤',
        status: 'skipped',
        sentAt: IN_RANGE,
      },
    ]);
    await tx.insert(schema.salesOrder).values([
      {
        id: createId('ord'),
        orgId: ORG_A,
        orderNo: 'SO-KPI-1',
        customerId: CUS_A,
        deliveryDate: '2026-12-31',
        amount: '1000.00',
        currency: 'USD',
        status: 'in_production',
        ownerId: USER_A,
      },
      {
        id: createId('ord'),
        orgId: ORG_A,
        orderNo: 'SO-KPI-2',
        customerId: CUS_A,
        deliveryDate: '2026-12-31',
        amount: '2000.00',
        currency: 'USD',
        status: 'completed',
        ownerId: USER_A,
      },
    ]);
    await tx.insert(schema.businessReport).values([
      {
        id: createId('rpt'),
        orgId: ORG_A,
        period: 'daily',
        periodStart: '2026-09-13',
        periodEnd: '2026-09-13',
        status: 'ready',
        content: '日报',
        citations: [],
        taskId: TASK_A,
        createdAt: IN_RANGE,
      },
      {
        id: createId('rpt'),
        orgId: ORG_A,
        period: 'daily',
        periodStart: '2026-09-12',
        periodEnd: '2026-09-12',
        status: 'ready',
        content: '昨日日报',
        citations: [],
        taskId: TASK_A,
        createdAt: BEFORE,
      },
    ]);
  });
});

afterAll(async () => {
  await closeDb(superDb);
  await closeDb(appDb);
});

describe('员工 KPI 精化口径（02 §3.2 P1）', () => {
  it('6 类指标按业务表聚合，且时间区间为半开 [start, end)', async () => {
    const counts = await withOrg(appDb, ORG_A, (tx) => fetchEmployeeKpiCounts(tx, ORG_A, RANGE));

    // lead_hunter：今日新增 2（区间内 1 + 起始边界 1；before/at_end 不计入、B 租户不计入）
    expect(kpiCountOf(counts, 'daily_leads', EMP_A)).toBe(2);
    // customer_researcher：今日完成分析 2（与 leads 同源，analyzed_at 落在区间）
    expect(kpiCountOf(counts, 'daily_profiles', EMP_A)).toBe(2);
    // sales：仅 out/ai/sent 且在区间内（in 方向与旧消息不计入）
    expect(kpiCountOf(counts, 'daily_replies', EMP_A)).toBe(1);
    // manager：今日生成报告 1（昨日报告与 B 租户不计入）
    expect(kpiCountOf(counts, 'daily_reports', EMP_A)).toBe(1);
    // 职能指标：跟单（在跟订单数）/ 跟进（sent 执行数）按 org 统计，任意员工取到同一值
    expect(kpiCountOf(counts, 'active_orders', EMP_A)).toBe(1);
    expect(kpiCountOf(counts, 'daily_followups', EMP_A)).toBe(1);
    expect(kpiCountOf(counts, 'daily_followups', EMP_A_OTHER)).toBe(1);
  });

  it('归因失败或无数据 → 0（不回落到他人/org 指标）', async () => {
    const counts = await withOrg(appDb, ORG_A, (tx) => fetchEmployeeKpiCounts(tx, ORG_A, RANGE));

    // 「A跟进员工」无 lead/回复/报告归因 → 3 个员工维度指标均为 0（职能指标除外，见上）
    expect(kpiCountOf(counts, 'daily_leads', EMP_A_OTHER)).toBe(0);
    expect(kpiCountOf(counts, 'daily_replies', EMP_A_OTHER)).toBe(0);
    expect(kpiCountOf(counts, 'daily_reports', EMP_A_OTHER)).toBe(0);
    // B 租户员工不出现在 A 租户聚合结果中（RLS + org 过滤）
    expect(kpiCountOf(counts, 'daily_leads', EMP_B)).toBe(0);
  });

  it('租户隔离：B 租户同区间数据只进 B 的结果', async () => {
    const counts = await withOrg(appDb, ORG_B, (tx) => fetchEmployeeKpiCounts(tx, ORG_B, RANGE));

    expect(kpiCountOf(counts, 'daily_leads', EMP_B)).toBe(1);
    expect(kpiCountOf(counts, 'daily_replies', EMP_B)).toBe(1);
    // B 租户没有订单/跟进执行/报告数据
    expect(kpiCountOf(counts, 'active_orders', EMP_B)).toBe(0);
    expect(kpiCountOf(counts, 'daily_followups', EMP_B)).toBe(0);
    expect(kpiCountOf(counts, 'daily_reports', EMP_B)).toBe(0);
  });
});
