/**
 * M5-B2 03 获客集成测试（后端开发计划表 B2）：
 * - lead-hunter/summary
 * - lead-tasks/parse
 * - lead-tasks（创建获客任务，复用 tasks 模块）
 * - leads 列表/详情/summary
 * - add-to-crm 三级去重
 * - batch-analyze（异步 → product_analysis 任务）
 * 前置：docker compose up（PG 5432 / Redis 6380）+ 迁移已执行。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { createId, ErrorCode } from '@tradepilot/core';
import { closeDb, createDb, schema, type Db, type OrgScopeContext } from '@tradepilot/db';
import { EnvService } from '../src/config/env.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { TokenService } from '../src/auth/token.service.js';
import { LeadsService } from '../src/leads/leads.service.js';
import { TasksService } from '../src/tasks/tasks.service.js';
import { CustomersService } from '../src/customers/customers.service.js';
import { TaskEnqueuer } from '@tradepilot/runtime';
import { TASK_TYPE } from '@tradepilot/shared';

process.env.JWT_SECRET ||= 'it_only_test_secret_0123456789abcdef0123456789abcdef';
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.REDIS_URL ||= 'redis://localhost:6380';
process.env.DATABASE_URL ||= 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';

const SUPER_URL = 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';
const APP_URL = 'postgresql://tradepilot_app:changeme_app@localhost:5432/tradepilot';

let superDb: Db;
let appDb: Db;
let redis: Redis;
let taskEnqueuer: TaskEnqueuer;

let orgId = '';
let adminId = '';
let salesId = '';
let adminCtx: OrgScopeContext;
let salesCtx: OrgScopeContext;
let leads: LeadsService;
let tasks: TasksService;
let customers: CustomersService;
let leadHunterEmpId = '';

const adminEmail = `it-m5b2-${createId('org')}@test.com`;
const salesEmail = `it-m5b2-sales-${createId('org')}@test.com`;

async function expectBiz(promise: Promise<unknown>, code: number): Promise<void> {
  try {
    await promise;
  } catch (err: unknown) {
    expect(err).toBeInstanceOf(Object);
    expect((err as { code: number }).code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 BizException(${code}) 但未抛出`);
}

beforeAll(async () => {
  superDb = createDb(SUPER_URL, { max: 2 });
  appDb = createDb(APP_URL, { max: 5 });
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
  const env = new EnvService();
  const tokens = new TokenService(env, redis);
  const auth = new AuthService(appDb, tokens, redis);

  const session = await auth.register({
    companyName: 'IT M5 B2 租户',
    contactName: '管理员',
    email: adminEmail,
    password: 'password123',
  });
  orgId = session.user.orgId;
  adminId = session.user.userId;

  salesId = createId('usr');
  await superDb.insert(schema.userAccount).values({
    id: salesId,
    orgId,
    email: salesEmail,
    passwordHash: 'fixture_no_login',
    name: '销售乙',
    role: 'sales',
    status: 'active',
  });

  // 使用种子数据创建的 lead_hunter 员工
  // 记录其 ID 供后续测试使用
  const [seedEmp] = await superDb
    .select({ id: schema.aiEmployee.id })
    .from(schema.aiEmployee)
    .where(and(eq(schema.aiEmployee.orgId, orgId), eq(schema.aiEmployee.role, 'lead_hunter')))
    .limit(1);
  leadHunterEmpId = seedEmp?.id ?? '';

  adminCtx = { orgId, userId: adminId, role: 'admin', scope: 'all' };
  salesCtx = { orgId, userId: salesId, role: 'sales', scope: 'self' };

  taskEnqueuer = new TaskEnqueuer(env.env.REDIS_URL);
  tasks = new TasksService(appDb, redis, env);
  customers = new CustomersService(appDb);
  leads = new LeadsService(appDb, tasks, customers);
}, 30_000);

afterAll(async () => {
  await taskEnqueuer.close();
  if (orgId) {
    await superDb.transaction(async (tx) => {
      await tx.delete(schema.approvalLog).where(eq(schema.approvalLog.orgId, orgId));
      await tx.delete(schema.approvalRequest).where(eq(schema.approvalRequest.orgId, orgId));
      await tx.delete(schema.llmCall).where(eq(schema.llmCall.orgId, orgId));
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
      // 解除 ai_lead ↔ customer 循环 FK 后删除
      await tx.update(schema.customer).set({ sourceLeadId: null }).where(eq(schema.customer.orgId, orgId));
      await tx.update(schema.aiLead).set({ convertedCustomerId: null }).where(eq(schema.aiLead.orgId, orgId));
      await tx.delete(schema.aiLeadContact).where(eq(schema.aiLeadContact.orgId, orgId));
      await tx.delete(schema.aiLead).where(eq(schema.aiLead.orgId, orgId));
      await tx.delete(schema.customer).where(eq(schema.customer.orgId, orgId));
      await tx.delete(schema.aiEmployee).where(eq(schema.aiEmployee.orgId, orgId));
      await tx.delete(schema.aiModelSetting).where(eq(schema.aiModelSetting.orgId, orgId));
      await tx.delete(schema.sopTemplate).where(eq(schema.sopTemplate.orgId, orgId));
      await tx.delete(schema.rolePermission).where(eq(schema.rolePermission.orgId, orgId));
      await tx.delete(schema.userAccount).where(eq(schema.userAccount.orgId, orgId));
      await tx.delete(schema.org).where(eq(schema.org.id, orgId));
    });
  }
  await redis.quit();
  await closeDb(appDb);
  await closeDb(superDb);
});

// ============================== B2-1 summary ==============================

describe('M5-B2-1 · lead-hunter/summary', () => {
  it('返回员工状态 + 今日产出 + 当前任务（无任务时 null）', async () => {
    const result = await leads.summary(adminCtx);
    expect(result.employee).toBeDefined();
    expect(result.employee!.name).toBe('AI 获客专员');
    expect(result.todaySummary).toBeDefined();
    expect(result.todaySummary.found).toBe(0);
    expect(result.currentTask).toBeNull();
  });
});

// ============================== B2-2 parse ==============================

describe('M5-B2-2 · lead-tasks/parse', () => {
  it('解析目标文本返回结构化字段', async () => {
    const result = await leads.parse(adminCtx, { goalText: '帮我找美国做跑鞋的品牌，可能需要碳纤维鞋垫' });
    expect(result.parsed.targetMarket).toBe('USA');
    expect(result.parsed.customerType).toBeTruthy();
    expect(result.parsed.targetProduct).toBeTruthy();
    expect(result.optimizedGoal).toBeTruthy();
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.reasons.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================== B2-3 createTask ==============================

describe('M5-B2-3 · lead-tasks 创建获客任务', () => {
  it('创建 lead_hunting 任务返回 taskId + status', async () => {
    const result = await leads.createTask(adminCtx, {
      goalText: '寻找美国跑鞋品牌',
      parsed: { targetMarket: 'USA', customerType: 'Shoe Brand', targetProduct: 'Carbon Insoles' },
      employeeId: leadHunterEmpId,
      targetCount: 35,
    });
    expect(result.taskId).toBeDefined();
    expect(['running', 'scheduled']).toContain(result.status);

    // 验证任务已落库
    const [task] = await superDb
      .select()
      .from(schema.aiTask)
      .where(eq(schema.aiTask.id, result.taskId));
    expect(task).toBeDefined();
    expect(task!.type).toBe('lead_hunting');
    expect(task!.employeeId).toBe(leadHunterEmpId);
  });
});

// ============================== B2-4 leads 列表/详情/summary ==============================

describe('M5-B2-4 · leads 列表/详情/summary', () => {
  let leadId1 = '';
  let leadId2 = '';
  let leadId3 = '';
  let existingCustomerId = '';

  beforeAll(async () => {
    leadId1 = createId('lead');
    leadId2 = createId('lead');
    leadId3 = createId('lead');

    // 先创建 customer 用于 inCrm=true 的 lead 的 FK 约束
    existingCustomerId = createId('cus');
    await superDb.insert(schema.customer).values({
      id: existingCustomerId,
      orgId,
      companyName: 'Gamma Ltd',
      country: 'UK',
      stage: 'new_lead',
      isFormal: false,
      ownerId: adminId,
      createdBy: adminId,
    });

    await superDb.insert(schema.aiLead).values([
      {
        id: leadId1,
        orgId,
        companyName: 'Alpha Sports Inc',
        country: 'US',
        industry: 'Sports',
        matchPct: 92,
        scoreLevel: 'high',
        insight: { value: 92, confidence: 0.92, reasons: [{ text: '产品高度匹配', evidence: '官网在售 Running Shoes', source: 'web_crawl' }] },
        inCrm: false,
      },
      {
        id: leadId2,
        orgId,
        companyName: 'Beta GmbH',
        country: 'Germany',
        industry: 'Automotive',
        matchPct: 65,
        scoreLevel: 'medium',
        insight: { value: 65, confidence: 0.65, reasons: [{ text: '部分匹配', source: 'web_search' }] },
        inCrm: false,
      },
      {
        id: leadId3,
        orgId,
        companyName: 'Gamma Ltd',
        country: 'UK',
        industry: 'Tech',
        matchPct: 35,
        scoreLevel: 'low',
        insight: { value: 35, confidence: 0.35, reasons: [{ text: '低匹配度', source: 'web_search' }] },
        inCrm: true,
        convertedCustomerId: existingCustomerId,
      },
    ]);
  });

  it('列表：分页 + 匹配度排序', async () => {
    const result = await leads.list(adminCtx, { page: 1, pageSize: 10 });
    expect(result.items.length).toBeGreaterThanOrEqual(3);
    // 按 matchPct DESC 排序
    expect(result.items[0]!.matchPct).toBeGreaterThanOrEqual(result.items[1]!.matchPct);
  });

  it('筛选：valueLevel=high', async () => {
    const result = await leads.list(adminCtx, { page: 1, pageSize: 10, valueLevel: 'high' });
    expect(result.items.every((i) => i.scoreLevel === 'high')).toBe(true);
    expect(result.items.length).toBe(1);
  });

  it('筛选：keyword', async () => {
    const result = await leads.list(adminCtx, { page: 1, pageSize: 10, keyword: 'Alpha' });
    expect(result.items.length).toBe(1);
    expect(result.items[0]!.companyName).toBe('Alpha Sports Inc');
  });

  it('筛选：inCrm=false', async () => {
    const result = await leads.list(adminCtx, { page: 1, pageSize: 10, inCrm: false });
    expect(result.items.every((i) => !i.inCrm)).toBe(true);
    expect(result.items.length).toBe(2);
  });

  it('summary 各价值档数量', async () => {
    const result = await leads.summaryCounts(adminCtx);
    expect(result.total).toBeGreaterThanOrEqual(3);
    expect(result.high).toBeGreaterThanOrEqual(1);
    expect(result.medium).toBeGreaterThanOrEqual(1);
    expect(result.low).toBeGreaterThanOrEqual(1);
  });

  it('详情：返回完整字段 + 联系人', async () => {
    const result = await leads.detail(adminCtx, leadId1);
    expect(result.companyName).toBe('Alpha Sports Inc');
    expect(result.country).toBe('US');
    expect(result.matchPct).toBe(92);
    expect(result.matchReasons.reasons.length).toBeGreaterThanOrEqual(1);
  });

  it('详情：不存在的 lead → 404', async () => {
    await expectBiz(leads.detail(adminCtx, 'lead_not_exist'), ErrorCode.NOT_FOUND);
  });
});

// ============================== B2-5 add-to-crm ==============================

describe('M5-B2-5 · add-to-crm 加入 CRM', () => {
  let leadToAdd1 = '';
  let leadToAdd2 = '';

  beforeAll(async () => {
    leadToAdd1 = createId('lead');
    leadToAdd2 = createId('lead');
    await superDb.insert(schema.aiLead).values([
      {
        id: leadToAdd1,
        orgId,
        companyName: 'NewCo GmbH',
        country: 'Germany',
        matchPct: 88,
        scoreLevel: 'high',
        insight: { value: 88, confidence: 0.88, reasons: [] },
        inCrm: false,
      },
      {
        id: leadToAdd2,
        orgId,
        companyName: 'Duplicate Ltd',
        country: 'UK',
        matchPct: 75,
        scoreLevel: 'medium',
        insight: { value: 75, confidence: 0.75, reasons: [] },
        inCrm: false,
      },
    ]);
    // 创建一个已有客户用于测试二级去重（公司名匹配）
    await superDb.insert(schema.customer).values({
      id: createId('cus'),
      orgId,
      companyName: 'Duplicate Ltd',
      country: 'UK',
      stage: 'new_lead',
      isFormal: false,
      ownerId: adminId,
      createdBy: adminId,
    });
  });

  it('新建客户：返回 created=1', async () => {
    const result = await leads.addToCrm(adminCtx, { leadIds: [leadToAdd1] });
    expect(result.created).toBe(1);
    expect(result.duplicated).toBe(0);
    expect(result.customers.length).toBe(1);
    expect(result.mapped.length).toBe(0);

    // 验证 lead 已标记 inCrm
    const [lead] = await superDb
      .select({ inCrm: schema.aiLead.inCrm, convertedCustomerId: schema.aiLead.convertedCustomerId })
      .from(schema.aiLead)
      .where(eq(schema.aiLead.id, leadToAdd1));
    expect(lead?.inCrm).toBe(true);
    expect(lead?.convertedCustomerId).toBeTruthy();

    // 验证 customer 已创建
    const [customer] = await superDb
      .select()
      .from(schema.customer)
      .where(eq(schema.customer.id, lead!.convertedCustomerId!));
    expect(customer?.companyName).toBe('NewCo GmbH');
  });

  it('二级去重（公司名）：命中已有客户返回 mapped', async () => {
    const result = await leads.addToCrm(adminCtx, { leadIds: [leadToAdd2] });
    expect(result.created).toBe(0);
    expect(result.mapped.length).toBe(1);
    expect(result.mapped[0]!.leadId).toBe(leadToAdd2);
  });

  it('已 inCrm 的 lead 重复提交：计入 duplicated', async () => {
    const result = await leads.addToCrm(adminCtx, { leadIds: [leadToAdd1] });
    expect(result.duplicated).toBe(1);
  });

  it('sales 越权指定他人 ownerId → 40301', async () => {
    await expectBiz(
      leads.addToCrm(salesCtx, { leadIds: [leadToAdd1], ownerId: adminId }),
      ErrorCode.FORBIDDEN,
    );
  });
});

// ============================== B2-6 batch-analyze ==============================

describe('M5-B2-6 · batch-analyze 批量分析', () => {
  let leadBatchId = '';

  beforeAll(async () => {
    leadBatchId = createId('lead');
    await superDb.insert(schema.aiLead).values({
      id: leadBatchId,
      orgId,
      companyName: 'AnalyzeMe Inc',
      country: 'US',
      matchPct: 80,
      scoreLevel: 'high',
      insight: { value: 80, confidence: 0.8, reasons: [] },
      inCrm: false,
    });
  });

  it('创建 product_analysis 任务', async () => {
    const result = await leads.batchAnalyze(adminCtx, { leadIds: [leadBatchId] });
    expect(result.taskId).toBeDefined();

    const [task] = await superDb
      .select()
      .from(schema.aiTask)
      .where(eq(schema.aiTask.id, result.taskId));
    expect(task).toBeDefined();
    expect(task!.type).toBe('product_analysis');
  });
});