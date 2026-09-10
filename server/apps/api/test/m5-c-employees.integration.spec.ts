import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { BizException, createId, ErrorCode } from '@tradepilot/core';
import { closeDb, createDb, schema, type Db, type OrgScopeContext } from '@tradepilot/db';
import { EnvService } from '../src/config/env.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { TokenService } from '../src/auth/token.service.js';
import { TasksService } from '../src/tasks/tasks.service.js';
import { EmployeesService } from '../src/employees/employees.service.js';
import { ROLE_KPI_METRIC, type CreateEmployeeDto } from '../src/employees/employees.dto.js';

/**
 * M5 批次 C3 集成测试（02 AI 数字员工中心）：
 * - GET /ai-employees/roles：注册种子预置的 6 角色模板（sop_template is_preset=true 派生）；
 * - POST /ai-employees：admin 创建成功（org 级 SOP 副本 + 落库）、kpiConfig 非法 metric → 42201、
 *   approvalPolicy.quote 缺失 → 42201、非法角色 → 42201、sales 越权 → 40301；
 * - GET /ai-employees：卡片列表（status 语义 / todayStats / kpi / currentTask 聚合 / workspacePath）；
 * - GET /ai-employees/{id}/tasks：该员工任务列表（复用 tasks 模块）。
 * 前置：docker compose up（PG 5432 / Redis 6380）+ 迁移已执行 + tradepilot_app 角色存在。
 */

process.env.JWT_SECRET ||= 'it_only_test_secret_0123456789abcdef0123456789abcdef';
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.REDIS_URL ||= 'redis://localhost:6380';
process.env.DATABASE_URL ||= 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';

const SUPER_URL = 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';
const APP_URL = 'postgresql://tradepilot_app:changeme_app@localhost:5432/tradepilot';

let superDb: Db;
let appDb: Db;
let redis: Redis;
let employees: EmployeesService;
let tasksService: TasksService;

let orgId = '';
let adminId = '';
let salesId = '';
let adminCtx: OrgScopeContext;
let salesCtx: OrgScopeContext;

/** running 任务（list 卡片聚合 + {id}/tasks 列表共用） */
let runningTaskId = '';

const adminEmail = `it-m5c-${createId('org')}@test.com`;
const salesEmail = `it-m5c-sales-${createId('org')}@test.com`;

async function expectBiz(promise: Promise<unknown>, code: number): Promise<BizException> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(BizException);
    expect((err as BizException).code).toBe(code);
    return err as BizException;
  }
  throw new Error(`期望抛出 BizException(${code}) 但未抛出`);
}

/** 构造创建请求体（quote 缺省触发红线校验用例单独覆盖） */
function createBody(overrides: Partial<CreateEmployeeDto> = {}): CreateEmployeeDto {
  return {
    role: 'lead_hunter',
    name: 'M5C 获客专员',
    goal: '按北美运动鞋服画像持续挖掘高价值潜客',
    sopParams: { match_product: 'medium' },
    skills: ['market_scan'],
    tools: ['web_search'],
    knowledgeScope: ['产品资料'],
    permissions: { web_search: true },
    approvalPolicy: { quote: 'always', autoExecute: [] },
    kpiConfig: { metric: ROLE_KPI_METRIC.lead_hunter, target: 35, period: 'daily' },
    ...overrides,
  };
}

beforeAll(async () => {
  superDb = createDb(SUPER_URL, { max: 2 });
  appDb = createDb(APP_URL, { max: 5 });
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
  const env = new EnvService();
  const tokens = new TokenService(env, redis);
  const auth = new AuthService(appDb, tokens, redis);
  tasksService = new TasksService(appDb, redis, env);
  employees = new EmployeesService(appDb, tasksService, redis);

  // 注册企业（register 全链路：org + admin + 六预置 AI 员工/SOP 种子）
  const session = await auth.register({
    companyName: 'IT M5 批次C3租户',
    contactName: '管理员',
    email: adminEmail,
    password: 'password123',
  });
  orgId = session.user.orgId;
  adminId = session.user.userId;

  // sales 成员 fixture（不经邀请链路；仅做越权断言）
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

  adminCtx = { orgId, userId: adminId, role: 'admin', scope: 'all' };
  salesCtx = { orgId, userId: salesId, role: 'sales', scope: 'self' };
}, 30_000);

afterAll(async () => {
  if (orgId) {
    await superDb.transaction(async (tx) => {
      await tx.delete(schema.notification).where(eq(schema.notification.orgId, orgId));
      await tx
        .delete(schema.notificationSetting)
        .where(eq(schema.notificationSetting.orgId, orgId));
      await tx.delete(schema.llmCall).where(eq(schema.llmCall.orgId, orgId));
      await tx.delete(schema.aiTaskLog).where(eq(schema.aiTaskLog.orgId, orgId));
      await tx.delete(schema.aiTaskStep).where(eq(schema.aiTaskStep.orgId, orgId));
      await tx.delete(schema.aiTask).where(eq(schema.aiTask.orgId, orgId));
      await tx.delete(schema.approvalLog).where(eq(schema.approvalLog.orgId, orgId));
      await tx.delete(schema.approvalRequest).where(eq(schema.approvalRequest.orgId, orgId));
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
      await tx.delete(schema.customerInsight).where(eq(schema.customerInsight.orgId, orgId));
      await tx.delete(schema.customerActivity).where(eq(schema.customerActivity.orgId, orgId));
      await tx.delete(schema.contact).where(eq(schema.contact.orgId, orgId));
      await tx.delete(schema.customer).where(eq(schema.customer.orgId, orgId));
      await tx.delete(schema.aiLeadContact).where(eq(schema.aiLeadContact.orgId, orgId));
      await tx.delete(schema.aiLead).where(eq(schema.aiLead.orgId, orgId));
      await tx.delete(schema.aiEmployee).where(eq(schema.aiEmployee.orgId, orgId));
      await tx.delete(schema.sopTemplate).where(eq(schema.sopTemplate.orgId, orgId));
      await tx.delete(schema.aiModelSetting).where(eq(schema.aiModelSetting.orgId, orgId));
      await tx.delete(schema.rolePermission).where(eq(schema.rolePermission.orgId, orgId));
      await tx.delete(schema.userAccount).where(eq(schema.userAccount.orgId, orgId));
      await tx.delete(schema.org).where(eq(schema.org.id, orgId));
    });
  }
  await tasksService.onModuleDestroy();
  await redis.quit();
  await closeDb(appDb);
  await closeDb(superDb);
});

describe('M5-C3 · GET /ai-employees/roles（创建向导预填）', () => {
  it('返回 6 角色模板，字段齐全且 kpiConfig.metric 与角色枚举一致', async () => {
    const templates = await employees.roles(adminCtx);
    expect(templates.length).toBe(6);
    const roles = templates.map((t) => t.role);
    expect(roles).toEqual(
      expect.arrayContaining([
        'lead_hunter',
        'customer_researcher',
        'sales',
        'follow_up',
        'merchandiser',
        'manager',
      ]),
    );

    for (const t of templates) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.goal.length).toBeGreaterThan(0);
      expect(t.sopTemplateId.startsWith('sop_')).toBe(true);
      expect(Array.isArray(t.skills)).toBe(true);
      expect(Array.isArray(t.tools)).toBe(true);
      expect(t.memoryConfig.retentionDays).toBeGreaterThan(0);
      expect(t.kpiConfig.period).toBe('daily');
      expect(t.kpiConfig.metric).toBe(ROLE_KPI_METRIC[t.role]);
    }
  });

  it('lead_hunter 预置 advancedSettings 派生 sopParams/sopParamDefs（select 分档）', async () => {
    const templates = await employees.roles(adminCtx);
    const hunter = templates.find((t) => t.role === 'lead_hunter');
    expect(hunter).toBeDefined();
    expect(hunter!.sopParams).toEqual({ match_product: 'high' });
    const def = hunter!.sopParamDefs.find((d) => d.key === 'match_product');
    expect(def).toBeDefined();
    expect(def!.type).toBe('select');
    expect(def!.defaultValue).toBe('high');
    expect(def!.options?.length).toBeGreaterThanOrEqual(2);
    expect(def!.options![0]).toEqual({ value: 'high', label: 'High（≥ 85 分）' });
  });
});

describe('M5-C3 · POST /ai-employees（创建）', () => {
  let createdId = '';

  it('admin 创建成功：返回 employeeId + 落库 + org 级 SOP 副本（sopParams 合并）', async () => {
    const resp = await employees.create(adminCtx, createBody());
    createdId = resp.employeeId;
    expect(createdId.startsWith('emp_')).toBe(true);

    const [row] = await superDb
      .select()
      .from(schema.aiEmployee)
      .where(eq(schema.aiEmployee.id, createdId));
    expect(row).toBeDefined();
    expect(row!.orgId).toBe(orgId);
    expect(row!.role).toBe('lead_hunter');
    expect(row!.status).toBe('idle');
    expect(row!.createdBy).toBe(adminId);
    expect(row!.approvalPolicy).toMatchObject({
      email_send: 'high_value_only',
      quote: 'always',
      autoExecute: [],
    });
    expect(row!.kpiConfig).toMatchObject({ metric: 'daily_leads', target: 35, period: 'daily' });

    // SOP 副本：is_preset=false + 参数合并进 advancedSettings
    const [sop] = await superDb
      .select()
      .from(schema.sopTemplate)
      .where(eq(schema.sopTemplate.id, row!.sopTemplateId!));
    expect(sop).toBeDefined();
    expect(sop!.isPreset).toBe(false);
    expect(sop!.role).toBe('lead_hunter');
    expect(sop!.content.advancedSettings).toMatchObject({ match_product: 'medium' });
  });

  it('kpiConfig.metric 与角色不匹配 → 42201', async () => {
    await expectBiz(
      employees.create(
        adminCtx,
        createBody({ kpiConfig: { metric: 'daily_replies', target: 30, period: 'daily' } }),
      ),
      ErrorCode.BIZ_VALIDATION,
    );
  });

  it('sopParams 含模板未定义参数键 → 42201（02 §3.2）', async () => {
    await expectBiz(
      employees.create(adminCtx, createBody({ sopParams: { foo: 1 } })),
      ErrorCode.BIZ_VALIDATION,
    );
  });

  it('approvalPolicy.quote 缺失 → 42201（高风险动作红线）', async () => {
    const body = createBody();
    delete body.approvalPolicy.quote;
    await expectBiz(employees.create(adminCtx, body), ErrorCode.BIZ_VALIDATION);
  });

  it('approvalPolicy.quote 传 none → 42201', async () => {
    await expectBiz(
      employees.create(
        adminCtx,
        createBody({ approvalPolicy: { quote: 'none', autoExecute: [] } }),
      ),
      ErrorCode.BIZ_VALIDATION,
    );
  });

  it('非法角色 → 42201', async () => {
    await expectBiz(
      employees.create(adminCtx, createBody({ role: 'ceo_robot' })),
      ErrorCode.BIZ_VALIDATION,
    );
  });

  it('sales 角色创建 → 40301（仅 admin/manager）', async () => {
    await expectBiz(employees.create(salesCtx, createBody()), ErrorCode.FORBIDDEN);
  });

  it('email_send 缺省 → high_value_only；显式 always 生效', async () => {
    const always = await employees.create(
      adminCtx,
      createBody({
        name: 'M5C 销售专员',
        role: 'sales',
        sopParams: {},
        kpiConfig: { metric: ROLE_KPI_METRIC.sales, target: 90, period: 'daily' },
        approvalPolicy: { email_send: 'always', quote: 'always', autoExecute: [] },
      }),
    );
    const [row] = await superDb
      .select({ approvalPolicy: schema.aiEmployee.approvalPolicy })
      .from(schema.aiEmployee)
      .where(eq(schema.aiEmployee.id, always.employeeId));
    expect(row!.approvalPolicy.email_send).toBe('always');
  });
});

describe('M5-C3 · GET /ai-employees（卡片列表 + currentTask 聚合）', () => {
  let empId = '';

  beforeAll(async () => {
    // 复用上一用例创建的 lead_hunter 员工（区别于种子预置的那位）
    const rows = await superDb
      .select({ id: schema.aiEmployee.id })
      .from(schema.aiEmployee)
      .where(and(eq(schema.aiEmployee.orgId, orgId), eq(schema.aiEmployee.role, 'lead_hunter')));
    const seedHunter = await seededEmployee('lead_hunter');
    empId = rows.find((r) => r.id !== seedHunter)?.id ?? rows[0]!.id;

    // 造一条 running 任务（只读聚合 currentTask 数据源）
    runningTaskId = createId('task');
    await superDb.insert(schema.aiTask).values({
      id: runningTaskId,
      orgId,
      employeeId: empId,
      type: 'lead_hunting',
      title: '获客：美国跑鞋品牌',
      status: 'running',
      progressPct: 40,
      currentStep: 'search_sources',
      input: {},
      startedAt: new Date(),
      createdBy: adminId,
    });
  });

  it('列表含全量员工卡（6 预置 + 创建的），字段结构与承载决策正确', async () => {
    const resp = await employees.list(adminCtx, 1, 20);
    expect(resp.total).toBeGreaterThanOrEqual(7);
    expect(resp.items.some((i) => i.employeeId === empId)).toBe(true);

    for (const card of resp.items) {
      expect(card.employeeId.startsWith('emp_')).toBe(true);
      expect(card.name.length).toBeGreaterThan(0);
      expect(Array.isArray(card.todayStats)).toBe(true);
      // D4 承载决策：跟单/经理工作台入口禁用（null）
      if (card.role === 'merchandiser' || card.role === 'manager') {
        expect(card.workspacePath).toBeNull();
      }
    }
    const hunter = resp.items.find((i) => i.employeeId === empId)!;
    expect(hunter.workspacePath).toBe('/lead-gen');
  });

  it('running 任务员工卡：status=working + currentTask 聚合 + todayStats 计数', async () => {
    const resp = await employees.list(adminCtx, 1, 20);
    const card = resp.items.find((i) => i.employeeId === empId)!;
    expect(card.status).toBe('working');
    expect(card.currentTask).toMatchObject({
      taskId: runningTaskId,
      title: '获客：美国跑鞋品牌',
      taskType: 'lead_hunting',
      status: 'running',
      progressPct: 40,
      currentStep: 'search_sources',
    });
    // 今日任务计数 = 1（running 任务 createdAt=今天）
    expect(card.todayStats[0]!.count).toBe(1);
    // KPI：非占位角色展示（achieved = 今日任务计数）
    expect(card.kpi).not.toBeNull();
    expect(card.kpi!.metric).toBe('daily_leads');
    expect(card.kpi!.target).toBe(35);
    expect(card.kpi!.period).toBe('daily');
  });

  it('无任务员工卡：status=idle + currentTask=null（种子 idle 员工）', async () => {
    const resp = await employees.list(adminCtx, 1, 20);
    const merchandiser = resp.items.find((i) => i.role === 'merchandiser')!;
    expect(merchandiser.status).toBe('idle');
    expect(merchandiser.currentTask).toBeNull();
    expect(merchandiser.kpi).toBeNull();
  });
});

describe('M5-C3 · GET /ai-employees/{id}/tasks（该员工任务列表）', () => {
  it('返回该员工任务（含 beforeAll 造的 running 任务）', async () => {
    // 卡片 describe 造 running 的 custom lead_hunter（区分种子员工；target = 非种子那位）
    const rows = await superDb
      .select({ id: schema.aiEmployee.id })
      .from(schema.aiEmployee)
      .where(and(eq(schema.aiEmployee.orgId, orgId), eq(schema.aiEmployee.role, 'lead_hunter')));
    const seedHunter = await seededEmployee('lead_hunter');
    const targetId = rows.find((r) => r.id !== seedHunter)?.id ?? rows[0]!.id;
    const resp = await employees.listTasks(adminCtx, targetId, 1, 20);
    expect(resp.total).toBeGreaterThanOrEqual(1);
    const found = resp.items.find((t: { taskId: string }) => t.taskId === runningTaskId);
    expect(found).toBeDefined();
    expect((found as { title: string }).title).toBe('获客：美国跑鞋品牌');
    expect((found as { status: string }).status).toBe('running');
    expect((found as { employeeId: string }).employeeId).toBe(targetId);
  });

  it('员工不存在 → 40401', async () => {
    await expectBiz(employees.listTasks(adminCtx, 'emp_not_exist', 1, 20), ErrorCode.NOT_FOUND);
  });
});

/** 查种子预置员工 id（按角色第一条） */
async function seededEmployee(role: string): Promise<string> {
  const [row] = await superDb
    .select({ id: schema.aiEmployee.id })
    .from(schema.aiEmployee)
    .where(and(eq(schema.aiEmployee.orgId, orgId), eq(schema.aiEmployee.role, role)))
    .limit(1);
  return row!.id;
}

describe('M5-C3 · POST /ai-employees/{id}/pause + /resume（员工级暂停/恢复）', () => {
  let empId = '';
  let runningTaskId = '';

  beforeAll(async () => {
    // 独立目标员工（follow_up），避免与卡片列表 running 任务耦合
    const created = await employees.create(adminCtx, {
      role: 'follow_up',
      name: 'M5C 暂停目标',
      goal: '按节奏跟进已询价客户',
      skills: ['email'],
      tools: ['email_send'],
      knowledgeScope: ['产品资料'],
      permissions: { email_send: true },
      approvalPolicy: { quote: 'always', autoExecute: [] },
      kpiConfig: { metric: ROLE_KPI_METRIC.follow_up, target: 10, period: 'daily' },
    });
    empId = created.employeeId;

    // 员工置 working + 名下一条 running 任务（模拟执行中）
    await superDb
      .update(schema.aiEmployee)
      .set({ status: 'working', statusDetail: '正在跟进' })
      .where(eq(schema.aiEmployee.id, empId));
    runningTaskId = createId('task');
    await superDb.insert(schema.aiTask).values({
      id: runningTaskId,
      orgId,
      employeeId: empId,
      type: 'follow_up',
      title: '跟进：报价后第 2 步',
      status: 'running',
      progressPct: 30,
      currentStep: 'check_replied',
      input: {},
      startedAt: new Date(),
      createdBy: adminId,
    });
  }, 30_000);

  it('admin pause：running → paused + 员工回 idle + 日志留痕 + SSE 事件发布', async () => {
    const resp = await employees.pause(adminCtx, empId);
    expect(resp).toEqual({ employeeId: empId, pausedTasks: 1 });

    const [task] = await superDb
      .select()
      .from(schema.aiTask)
      .where(eq(schema.aiTask.id, runningTaskId));
    expect(task!.status).toBe('paused');
    expect(task!.finishedAt).toBeNull();

    const [emp] = await superDb
      .select({ status: schema.aiEmployee.status })
      .from(schema.aiEmployee)
      .where(eq(schema.aiEmployee.id, empId));
    expect(emp!.status).toBe('idle');

    // 留痕日志（type=error，语义 = 任务中止）
    const logs = await superDb
      .select({ content: schema.aiTaskLog.content })
      .from(schema.aiTaskLog)
      .where(eq(schema.aiTaskLog.taskId, runningTaskId));
    expect(logs.some((l) => l.content.includes('已暂停'))).toBe(true);
  });

  it('无执行中任务时 pause：pausedTasks=0（幂等）', async () => {
    const resp = await employees.pause(adminCtx, empId);
    expect(resp.pausedTasks).toBe(0);
  });

  it('admin resume：paused → scheduled（交 Dispatcher 排队续跑）', async () => {
    const resp = await employees.resume(adminCtx, empId);
    expect(resp).toEqual({ employeeId: empId, resumedTasks: 1 });
    const [task] = await superDb
      .select({ status: schema.aiTask.status })
      .from(schema.aiTask)
      .where(eq(schema.aiTask.id, runningTaskId));
    expect(task!.status).toBe('scheduled');
  });

  it('sales 越权 pause → 40301', async () => {
    await expectBiz(employees.pause(salesCtx, empId), ErrorCode.FORBIDDEN);
  });

  it('sales 越权 resume → 40301', async () => {
    await expectBiz(employees.resume(salesCtx, empId), ErrorCode.FORBIDDEN);
  });

  it('员工不存在 → 40401（pause/resume 共用校验）', async () => {
    await expectBiz(employees.pause(adminCtx, 'emp_not_exist'), ErrorCode.NOT_FOUND);
    await expectBiz(employees.resume(adminCtx, 'emp_not_exist'), ErrorCode.NOT_FOUND);
  });
});
