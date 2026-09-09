/**
 * M5-B3 04 客户360° 集成测试（后端开发计划表 B3）：
 * - GET /customers/{id} 头部 + Overview
 * - POST /customers/{id}/analyze 触发 AI 分析（异步）
 * - GET /customers/{id}/insights AI 客户洞察
 * - GET /customers/{id}/contacts 联系人列表
 * - GET /customers/{id}/conversations 会话列表
 * - GET /customers/{id}/quotes 历史报价（D6 降级）
 * - GET /customers/{id}/orders 历史订单（D6 降级）
 * - GET /customers/{id}/activities 活动时间线
 * - POST /contacts/{id}/generate-outreach 生成开发信
 * - POST /leads/{id}/convert 单条 lead 转 CRM
 * 前置：docker compose up（PG 5432 / Redis 6380）+ 迁移已执行。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { createId, ErrorCode } from '@tradepilot/core';
import { closeDb, createDb, schema, type Db, type OrgScopeContext } from '@tradepilot/db';
import { EnvService } from '../src/config/env.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { TokenService } from '../src/auth/token.service.js';
import { CustomersService } from '../src/customers/customers.service.js';
import { LeadsService } from '../src/leads/leads.service.js';
import { TasksService } from '../src/tasks/tasks.service.js';
import { TaskEnqueuer } from '@tradepilot/runtime';

process.env.JWT_SECRET ||= 'it_only_test_secret_0123456789abcdef0123456789abcdef';
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.DATABASE_URL ||= 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';

const SUPER_URL = 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';
const APP_URL = 'postgresql://tradepilot_app:changeme_app@localhost:5432/tradepilot';

let superDb: Db;
let appDb: Db;
let redis: Redis;
let taskEnqueuer: TaskEnqueuer;

let orgId = '';
let adminId = '';
let adminCtx: OrgScopeContext;
let customerId = '';
let contactId = '';
let leadId = '';
let leadHunterEmpId = '';

const adminEmail = `it-m5b3-${createId('org')}@test.com`;

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
    companyName: 'IT M5 B3 租户',
    contactName: '管理员',
    email: adminEmail,
    password: 'password123',
  });
  orgId = session.user.orgId;
  adminId = session.user.userId;

  adminCtx = { orgId, userId: adminId, role: 'admin', scope: 'all' };

  taskEnqueuer = new TaskEnqueuer(env.env.REDIS_URL);
  const tasks = new TasksService(appDb, redis, env);
  const customers = new CustomersService(appDb, tasks);
  const leads = new LeadsService(appDb, tasks, customers);

  // 记录客户、联系人、lead 等测试数据
  customerId = createId('cus');
  contactId = createId('cont');
  leadId = createId('lead');

  const [seedEmp] = await superDb
    .select({ id: schema.aiEmployee.id })
    .from(schema.aiEmployee)
    .where(and(eq(schema.aiEmployee.orgId, orgId), eq(schema.aiEmployee.role, 'lead_hunter')))
    .limit(1);
  leadHunterEmpId = seedEmp?.id ?? '';

  // 创建测试客户
  await superDb.insert(schema.customer).values({
    id: customerId,
    orgId,
    companyName: 'B3 Test Corp',
    country: 'US',
    website: 'https://b3testcorp.com',
    industry: 'Sports',
    industryTags: ['Running', 'Sports'],
    customerType: 'brand',
    stage: 'negotiation',
    isFormal: true,
    score: 88,
    ownerId: adminId,
    createdBy: adminId,
  });

  // 创建测试联系人
  await superDb.insert(schema.contact).values({
    id: contactId,
    orgId,
    customerId,
    name: 'John Doe',
    title: 'Purchasing Manager',
    email: 'john@b3testcorp.com',
    decisionInfluencePct: 75,
    decisionInfluenceReasons: [{ text: '采购负责人', source: 'manual' }],
    isPrimary: true,
  });

  // 创建测试 lead
  await superDb.insert(schema.aiLead).values({
    id: leadId,
    orgId,
    companyName: 'ConvertMe Inc',
    country: 'US',
    matchPct: 85,
    scoreLevel: 'high',
    insight: { value: 85, confidence: 0.85, reasons: [] },
    inCrm: false,
  });

  // 创建测试活动
  await superDb.insert(schema.customerActivity).values({
    id: createId('act'),
    orgId,
    customerId,
    type: 'stage_change',
    summary: '阶段流转 new_lead → negotiation',
    operatorType: 'user',
    operatorId: adminId,
    operatorName: '管理员',
    refType: 'customer',
    refId: customerId,
  });

  // 创建测试客户洞察
  await superDb.insert(schema.customerInsight).values({
    id: createId('ins'),
    orgId,
    customerId,
    insightType: 'purchase_probability',
    value: '92',
    confidence: '0.88',
    reasons: [{ text: '产品高度匹配', evidence: '官网在售同类产品', source: 'web_crawl' }],
    nextAction: { type: 'contact_decision_maker', label: '联系采购负责人 →', targetId: contactId },
    generatedAt: new Date(),
  });

  // 创建测试会话
  await superDb.insert(schema.conversation).values({
    id: createId('conv'),
    orgId,
    customerId,
    contactId,
    channel: 'email',
    subject: '业务合作探讨',
    priority: 'high',
    unreadCount: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // 保存服务引用供测试使用
  (globalThis as Record<string, unknown>).__customers = customers;
  (globalThis as Record<string, unknown>).__leads = leads;
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

// ============================== B3-1 detail ==============================

describe('M5-B3-1 · GET /customers/{id} 客户详情 + Overview', () => {
  it('返回客户头部信息 + Overview', async () => {
    const customers = (globalThis as Record<string, unknown>).__customers as CustomersService;
    const result = await customers.detail(adminCtx, customerId);
    expect(result.customerId).toBe(customerId);
    expect(result.companyName).toBe('B3 Test Corp');
    expect(result.score).toBe(88);
    expect(result.country).toBe('US');
    expect(result.website).toBe('https://b3testcorp.com');
    expect(result.industryTags).toContain('Sports');
    expect(result.stage).toBe('negotiation');
    expect(result.inCrm).toBe(true);
    expect(result.overview).toBeDefined();
    expect(result.overview.customerType).toBe('brand');
  });

  it('不存在的客户 → 404', async () => {
    const customers = (globalThis as Record<string, unknown>).__customers as CustomersService;
    await expectBiz(customers.detail(adminCtx, 'cus_not_exist'), ErrorCode.NOT_FOUND);
  });
});

// ============================== B3-2 analyze ==============================

describe('M5-B3-2 · POST /customers/{id}/analyze', () => {
  it('触发 AI 分析（异步 → product_analysis 任务）', async () => {
    const customers = (globalThis as Record<string, unknown>).__customers as CustomersService;
    const result = await customers.analyze(adminCtx, customerId, { scope: 'overview' });
    expect(result.taskId).toBeDefined();

    const [task] = await superDb
      .select()
      .from(schema.aiTask)
      .where(eq(schema.aiTask.id, result.taskId));
    expect(task).toBeDefined();
    expect(task!.type).toBe('product_analysis');
  });
});

// ============================== B3-3 insights ==============================

describe('M5-B3-3 · GET /customers/{id}/insights AI 客户洞察', () => {
  it('返回客户洞察列表', async () => {
    const customers = (globalThis as Record<string, unknown>).__customers as CustomersService;
    const result = await customers.insights(adminCtx, customerId);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const insight = result.find((i) => i.insightType === 'purchase_probability');
    expect(insight).toBeDefined();
    expect(Number(insight!.value)).toBe(92);
    expect(Number(insight!.confidence)).toBeCloseTo(0.88);
    expect(insight!.reasons.length).toBeGreaterThanOrEqual(1);
    expect(insight!.nextAction).toBeDefined();
    expect(insight!.nextAction!.type).toBe('contact_decision_maker');
  });
});

// ============================== B3-4 contacts ==============================

describe('M5-B3-4 · GET /customers/{id}/contacts 联系人列表', () => {
  it('返回客户联系人列表', async () => {
    const customers = (globalThis as Record<string, unknown>).__customers as CustomersService;
    const result = await customers.listCustomerContacts(adminCtx, customerId, 1, 10);
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(result.items[0]!.name).toBe('John Doe');
    expect(result.items[0]!.title).toBe('Purchasing Manager');
    expect(result.items[0]!.email).toBe('john@b3testcorp.com');
    expect(result.items[0]!.decisionInfluencePct).toBe(75);
  });
});

// ============================== B3-5 conversations ==============================

describe('M5-B3-5 · GET /customers/{id}/conversations 会话列表', () => {
  it('返回客户会话列表', async () => {
    const customers = (globalThis as Record<string, unknown>).__customers as CustomersService;
    const result = await customers.listCustomerConversations(adminCtx, customerId, 1, 10);
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(result.items[0]!.subject).toBe('业务合作探讨');
  });
});

// ============================== B3-6 quotes (D6 降级) ==============================

describe('M5-B3-6 · GET /customers/{id}/quotes 历史报价（D6 降级）', () => {
  it('返回未启用状态', async () => {
    const customers = (globalThis as Record<string, unknown>).__customers as CustomersService;
    const result = await customers.listCustomerQuotes(adminCtx, customerId, 1, 10);
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.disabled).toBe(true);
  });
});

// ============================== B3-7 orders (D6 降级) ==============================

describe('M5-B3-7 · GET /customers/{id}/orders 历史订单（D6 降级）', () => {
  it('返回未启用状态', async () => {
    const customers = (globalThis as Record<string, unknown>).__customers as CustomersService;
    const result = await customers.listCustomerOrders(adminCtx, customerId, 1, 10);
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.disabled).toBe(true);
  });
});

// ============================== B3-8 activities ==============================

describe('M5-B3-8 · GET /customers/{id}/activities 活动时间线', () => {
  it('返回客户活动列表', async () => {
    const customers = (globalThis as Record<string, unknown>).__customers as CustomersService;
    const result = await customers.listCustomerActivities(adminCtx, customerId, 1, 10);
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(result.items[0]!.type).toBe('stage_change');
    expect(result.items[0]!.summary).toContain('阶段流转');
  });
});

// ============================== B3-9 generate-outreach ==============================

describe('M5-B3-9 · POST /contacts/{id}/generate-outreach 生成开发信', () => {
  it('生成开发信草稿返回 draftId + conversationId + content', async () => {
    const customers = (globalThis as Record<string, unknown>).__customers as CustomersService;
    const result = await customers.generateOutreach(adminCtx, contactId, {
      scenario: 'cold_outreach',
      language: 'en',
    });
    expect(result.draftId).toBeDefined();
    expect(result.conversationId).toBeDefined();
    expect(result.content).toContain('Dear John Doe');

    // 验证草稿已落库
    const [msg] = await superDb
      .select()
      .from(schema.message)
      .where(eq(schema.message.id, result.draftId));
    expect(msg).toBeDefined();
    expect(msg!.status).toBe('draft');
    expect(msg!.direction).toBe('out');
  });

  it('不存在的联系人 → 404', async () => {
    const customers = (globalThis as Record<string, unknown>).__customers as CustomersService;
    await expectBiz(
      customers.generateOutreach(adminCtx, 'cont_not_exist', { scenario: 'cold_outreach' }),
      ErrorCode.NOT_FOUND,
    );
  });
});

// ============================== B3-10 convert ==============================

describe('M5-B3-10 · POST /leads/{id}/convert 单条 lead 转 CRM', () => {
  it('转换成功返回 created=1', async () => {
    const leads = (globalThis as Record<string, unknown>).__leads as LeadsService;
    const result = await leads.convert(adminCtx, leadId, {});
    expect(result.created).toBe(1);
    expect(result.duplicated).toBe(0);

    // 验证 lead 已标记
    const [lead] = await superDb
      .select({ inCrm: schema.aiLead.inCrm, convertedCustomerId: schema.aiLead.convertedCustomerId })
      .from(schema.aiLead)
      .where(eq(schema.aiLead.id, leadId));
    expect(lead?.inCrm).toBe(true);
    expect(lead?.convertedCustomerId).toBeTruthy();
  });

  it('已转换的 lead 重复提交 → duplicated', async () => {
    const leads = (globalThis as Record<string, unknown>).__leads as LeadsService;
    const result = await leads.convert(adminCtx, leadId, {});
    expect(result.duplicated).toBe(1);
  });
});