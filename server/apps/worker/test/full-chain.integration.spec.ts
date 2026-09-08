import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Redis as IORedis, type Redis } from 'ioredis';
import pino from 'pino';
import {
  ApprovalGate,
  GraphCompiler,
  LlmGateway,
  TaskEnqueuer,
  TaskEventPublisher,
  TaskRunner,
  createCheckpointer,
  heartbeatKey,
} from '@tradepilot/runtime';
import { closeDb, createDb, schema, type Db } from '@tradepilot/db';
import { createId } from '@tradepilot/core';
import { SSE_EVENT_TYPE, TASK_STATUS, taskEventChannel, taskEventSchema } from '@tradepilot/shared';
import { createToolRegistry } from '@tradepilot/tools';
import {
  createFlowRegistry,
  createOutputSchemaRegistry,
  createPromptRegistry,
  workflowSopProvider,
} from '@tradepilot/workflows';

/**
 * M3 全链路集成测试（后端开发计划表 M3 出口标准）：
 * 入队（BullMQ jobId=taskId）→ TaskRunner 领取 → 图执行（mock LLM + mock 工具）→ 落库
 * （ai_task/steps/logs/llm_call/ai_lead/message/follow_up_execution）→ SSE 推送（task:{id}:events）。
 * 附带审批挂起 → 批准 → resume 续跑 → 排期下一步 的完整闸门链路。
 * 前置：docker compose up（PG 5432 / Redis 6380）+ `pnpm --filter @tradepilot/db migrate`。
 */

const SUPER_URL =
  process.env.TEST_SUPER_DATABASE_URL ??
  'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';

const logger = pino({ level: process.env.TEST_LOG_LEVEL ?? 'silent' });

let db: Db;
let redis: Redis;
let runner: TaskRunner;
let enqueuer: TaskEnqueuer;
let stopCheckpointer: () => Promise<void>;

const ORG = createId('org');
const USER = createId('usr');
const EMP_LEAD = createId('aie');
const EMP_FU = createId('aie');
const CUSTOMER = createId('cus');
const STRATEGY = createId('fstr');
const STRATEGY_STEP_1 = createId('fstp');
const STRATEGY_STEP_2 = createId('fstp');
const FT = createId('ftask');
const CONV = createId('conv');

interface RecordedEvent {
  type: string;
  seq: string;
  payload: Record<string, unknown>;
}

/** 订阅任务事件频道并收集消息（run 前订阅，防丢事件） */
async function collectEvents(redisClient: Redis, taskId: string): Promise<RecordedEvent[]> {
  const events: RecordedEvent[] = [];
  const sub = redisClient.duplicate();
  await sub.subscribe(taskEventChannel(taskId));
  sub.on('message', (_channel, raw) => {
    events.push(JSON.parse(raw) as RecordedEvent);
  });
  return events;
}

/** 等待 done 事件落袋（PUBLISH 为 fire-and-forget，给订阅端少量缓冲时间） */
async function waitUntil(events: RecordedEvent[], pred: (e: RecordedEvent) => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (events.some(pred)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  db = createDb(SUPER_URL, { max: 5 });
  redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

  // ===== Runtime 装配（与 worker bootstrap 同构，checkpointer 走真实 PostgresSaver）=====
  const checkpointer = await createCheckpointer(SUPER_URL);
  stopCheckpointer = checkpointer.close;
  const publisher = new TaskEventPublisher(redis);
  const gateway = new LlmGateway(db, logger, { provider: 'mock', defaultModel: 'mock-1' });
  const gate = new ApprovalGate(db, redis, publisher, logger);
  const compiler = new GraphCompiler({
    db,
    redis,
    logger,
    publisher,
    gateway,
    gate,
    tools: createToolRegistry(),
    flows: createFlowRegistry(),
    prompts: createPromptRegistry(),
    outputSchemas: createOutputSchemaRegistry(),
    checkpointer: checkpointer.saver,
  });
  runner = new TaskRunner({ db, redis, logger, publisher, compiler, sops: workflowSopProvider });
  enqueuer = new TaskEnqueuer(REDIS_URL);

  // ===== 引导数据 =====
  await db.transaction(async (tx) => {
    await tx.insert(schema.org).values({ id: ORG, name: 'M3全链路租户', timezone: 'Asia/Shanghai' });
    await tx.insert(schema.userAccount).values({
      id: USER,
      orgId: ORG,
      email: `it-fullchain-${ORG}@test.com`,
      passwordHash: 'x',
      name: '测试管理员',
      role: 'admin',
      status: 'active',
    });
    await tx.insert(schema.aiEmployee).values([
      {
        id: EMP_LEAD,
        orgId: ORG,
        role: 'lead_hunter',
        name: '获客员',
        goal: '完成获客目标',
        tools: ['web_search', 'site_crawl', 'find_contact', 'lookup_contact', 'crm_write', 'knowledge_search'],
        permissions: {},
        approvalPolicy: { email_send: 'high_value_only', quote: 'always', autoExecute: [] },
        kpiConfig: [{ metric: 'leads', target: 5, period: 'daily' }],
      },
      {
        id: EMP_FU,
        orgId: ORG,
        role: 'follow_up',
        name: '跟进员',
        goal: '按策略跟进客户',
        tools: ['knowledge_search', 'email_send'],
        permissions: {},
        approvalPolicy: { email_send: 'high_value_only', quote: 'always', autoExecute: [] },
        kpiConfig: [{ metric: 'touches', target: 5, period: 'daily' }],
      },
    ]);
    await tx.insert(schema.customer).values({
      id: CUSTOMER,
      orgId: ORG,
      companyName: '全链路测试客户',
      country: 'US',
      ownerId: USER,
    });
    await tx.insert(schema.followUpStrategy).values({
      id: STRATEGY,
      orgId: ORG,
      name: 'M3 测试策略',
      targetScope: {},
      autoSendPolicy: 'manual_review',
      isDefault: false,
    });
    await tx.insert(schema.followUpStrategyStep).values([
      { id: STRATEGY_STEP_1, orgId: ORG, strategyId: STRATEGY, seq: 1, dayOffset: 0, title: '首触' },
      { id: STRATEGY_STEP_2, orgId: ORG, strategyId: STRATEGY, seq: 2, dayOffset: 3, title: '价值跟进' },
    ]);
    await tx.insert(schema.followUpTask).values({
      id: FT,
      orgId: ORG,
      customerId: CUSTOMER,
      strategyId: STRATEGY,
      status: 'ready',
      nextRunAt: new Date(),
    });
    await tx.insert(schema.conversation).values({
      id: CONV,
      orgId: ORG,
      customerId: CUSTOMER,
      channel: 'email',
      subject: 'M3 全链路会话',
    });
  });
});

afterAll(async () => {
  await db.transaction(async (tx) => {
    await tx.delete(schema.llmCall).where(eq(schema.llmCall.orgId, ORG));
    await tx.delete(schema.aiTaskLog).where(eq(schema.aiTaskLog.orgId, ORG));
    await tx.delete(schema.aiTaskStep).where(eq(schema.aiTaskStep.orgId, ORG));
    // 发现池先行（ai_lead.task_id → ai_task FK），再删任务
    await tx.delete(schema.aiLeadContact).where(eq(schema.aiLeadContact.orgId, ORG));
    await tx.delete(schema.aiLead).where(eq(schema.aiLead.orgId, ORG));
    await tx.delete(schema.aiTask).where(eq(schema.aiTask.orgId, ORG));
    await tx.delete(schema.approvalLog).where(eq(schema.approvalLog.orgId, ORG));
    await tx.delete(schema.approvalRequest).where(eq(schema.approvalRequest.orgId, ORG));
    await tx.delete(schema.followUpExecution).where(eq(schema.followUpExecution.orgId, ORG));
    await tx.delete(schema.followUpTask).where(eq(schema.followUpTask.orgId, ORG));
    await tx.delete(schema.followUpStrategyStep).where(eq(schema.followUpStrategyStep.orgId, ORG));
    await tx.delete(schema.followUpStrategy).where(eq(schema.followUpStrategy.orgId, ORG));
    await tx.delete(schema.message).where(eq(schema.message.orgId, ORG));
    await tx.delete(schema.conversation).where(eq(schema.conversation.orgId, ORG));
    await tx.delete(schema.customerActivity).where(eq(schema.customerActivity.orgId, ORG));
    await tx.delete(schema.customer).where(eq(schema.customer.orgId, ORG));
    await tx.delete(schema.aiEmployee).where(eq(schema.aiEmployee.orgId, ORG));
    await tx.delete(schema.userAccount).where(eq(schema.userAccount.orgId, ORG));
    await tx.delete(schema.org).where(eq(schema.org.id, ORG));
  });
  await closeDb(db);
  await enqueuer.close();
  await stopCheckpointer();
  redis.disconnect();
});

/** lead_hunting 任务行 */
async function insertLeadTask(): Promise<string> {
  const taskId = createId('task');
  await db.insert(schema.aiTask).values({
    id: taskId,
    orgId: ORG,
    employeeId: EMP_LEAD,
    type: 'lead_hunting',
    title: 'M3 获客全链路',
    status: 'scheduled',
    input: { goal: '寻找美国机械零件采购商', targetCount: 1 },
  });
  return taskId;
}

describe('全链路：lead_hunting 入队 → Runner → 图执行 → 落库 → SSE', () => {
  it('任务完成且全链路可观测', async () => {
    const taskId = await insertLeadTask();

    // ① 入队：jobId=taskId 防重复，BullMQ 活跃 job 可查
    await enqueuer.enqueueTask(taskId, 'lead_hunting');
    expect(await enqueuer.hasActiveJob(taskId, 'lead_hunting')).toBe(true);

    // ② SSE 先订阅后执行（04 §6 防丢事件）
    const events = await collectEvents(redis, taskId);

    // ③ Runner 执行（processor 语义 = runner.run）
    const result = await runner.run(taskId);
    expect(result.status).toBe('completed');
    expect(result.outputs?.[0]?.['type']).toBe('leads');

    // ④ 落库：任务终态 + 员工回 idle + 心跳清理
    const [task] = await db
      .select({ status: schema.aiTask.status, outputs: schema.aiTask.outputs, progressPct: schema.aiTask.progressPct, finishedAt: schema.aiTask.finishedAt })
      .from(schema.aiTask)
      .where(eq(schema.aiTask.id, taskId));
    expect(task.status).toBe('completed');
    expect(task.progressPct).toBe(100);
    expect(task.finishedAt).not.toBeNull();
    // 14 §1.2 类型化 outputs：leads payload（发现池列表 + 统计）
    const leadsOut = (task.outputs as Record<string, unknown>[])[0];
    expect(leadsOut?.['type']).toBe('leads');
    expect((leadsOut?.['payload'] as Record<string, unknown>)['leads']).toHaveLength(1);
    expect((leadsOut?.['payload'] as Record<string, unknown>)['foundCount']).toBe(1);
    const [emp] = await db.select({ status: schema.aiEmployee.status }).from(schema.aiEmployee).where(eq(schema.aiEmployee.id, EMP_LEAD));
    expect(emp.status).toBe('idle');
    expect(await redis.exists(heartbeatKey(taskId))).toBe(0);

    // 步骤全 completed；日志与 llm_call 记账可查；发现池已写入
    const steps = await db.select({ status: schema.aiTaskStep.status }).from(schema.aiTaskStep).where(eq(schema.aiTaskStep.taskId, taskId));
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((s) => s.status === 'completed')).toBe(true);
    const logs = await db.select({ id: schema.aiTaskLog.id }).from(schema.aiTaskLog).where(eq(schema.aiTaskLog.taskId, taskId));
    expect(logs.length).toBeGreaterThan(0);
    const llmCalls = await db.select({ node: schema.llmCall.node }).from(schema.llmCall).where(eq(schema.llmCall.taskId, taskId));
    expect(new Set(llmCalls.map((c) => c.node))).toEqual(new Set(['parse_goal', 'plan_search', 'match_product']));
    const leads = await db.select({ id: schema.aiLead.id }).from(schema.aiLead).where(eq(schema.aiLead.taskId, taskId));
    expect(leads.length).toBe(1);

    // ⑤ SSE：status(running) → progress → log → done(completed)，且事件契约可校验
    await waitUntil(events, (e) => e.type === SSE_EVENT_TYPE.DONE);
    expect(events[0]?.type).toBe(SSE_EVENT_TYPE.STATUS);
    for (const e of events) {
      expect(taskEventSchema.safeParse(e).success).toBe(true);
    }
    const types = new Set(events.map((e) => e.type));
    expect(types.has(SSE_EVENT_TYPE.STATUS)).toBe(true);
    expect(types.has(SSE_EVENT_TYPE.PROGRESS)).toBe(true);
    expect(types.has(SSE_EVENT_TYPE.LOG)).toBe(true);
    const done = events.find((e) => e.type === SSE_EVENT_TYPE.DONE);
    expect(done?.payload?.['status']).toBe('completed');
  });

  it('幂等：重复投递（任务已终态）跳过执行且不重复写发现池', async () => {
    const taskId = await insertLeadTask();
    await runner.run(taskId);
    const afterFirst = await db.select({ id: schema.aiLead.id }).from(schema.aiLead).where(eq(schema.aiLead.taskId, taskId));
    const again = await runner.run(taskId);
    expect(again.status).toBe('skipped');
    const leads = await db.select({ id: schema.aiLead.id }).from(schema.aiLead).where(eq(schema.aiLead.taskId, taskId));
    expect(leads.length).toBe(afterFirst.length);
    expect(afterFirst.length).toBe(1);
  });
});

describe('全链路：follow_up 审批挂起 → 批准 → resume 续跑 → 排期下一步', () => {
  it('medium 邮件默认人工审：挂起冻结，批准后续跑发送并排期第 2 步', async () => {
    const taskId = createId('task');
    await db.insert(schema.aiTask).values({
      id: taskId,
      orgId: ORG,
      employeeId: EMP_FU,
      type: 'follow_up',
      title: 'M3 跟进全链路',
      status: 'scheduled',
      input: { followUpTaskId: FT, customerId: CUSTOMER, conversationId: CONV },
    });
    const events = await collectEvents(redis, taskId);

    // ① 首跑：email_send（medium，无 autoApprove）→ interrupt → waiting_approval
    const first = await runner.run(taskId);
    expect(first.status).toBe('waiting_approval');

    const [task1] = await db
      .select({ status: schema.aiTask.status, linkedApprovalId: schema.aiTask.linkedApprovalId })
      .from(schema.aiTask)
      .where(eq(schema.aiTask.id, taskId));
    expect(task1.status).toBe('waiting_approval');
    const approvalId = task1.linkedApprovalId as string;
    expect(approvalId).toBeTruthy();

    // 审批单 pending + 48h 超时；跟进任务同步挂起且 next_run_at 冻结；员工卡片挂起
    const [req] = await db
      .select({ status: schema.approvalRequest.status, bizId: schema.approvalRequest.bizId, expiresAt: schema.approvalRequest.expiresAt, proposal: schema.approvalRequest.aiProposal })
      .from(schema.approvalRequest)
      .where(eq(schema.approvalRequest.id, approvalId));
    expect(req.status).toBe('pending');
    expect(req.bizId).toBe(taskId);
    expect((req.proposal as Record<string, unknown>)['nodeId']).toBe('email_send');
    const [ft1] = await db
      .select({ status: schema.followUpTask.status, nextRunAt: schema.followUpTask.nextRunAt })
      .from(schema.followUpTask)
      .where(eq(schema.followUpTask.id, FT));
    expect(ft1.status).toBe('waiting_approval');
    expect(ft1.nextRunAt).not.toBeNull();
    const frozenAt = ft1.nextRunAt as Date;
    const [emp1] = await db.select({ status: schema.aiEmployee.status }).from(schema.aiEmployee).where(eq(schema.aiEmployee.id, EMP_FU));
    expect(emp1.status).toBe('waiting_approval');

    // SSE status 事件携带 linkedApprovalId
    await waitUntil(events, (e) => e.type === SSE_EVENT_TYPE.STATUS && e.payload?.['status'] === 'waiting_approval');
    const statusEvt = events.find((e) => e.type === SSE_EVENT_TYPE.STATUS && e.payload?.['status'] === 'waiting_approval');
    expect(statusEvt?.payload?.['linkedApprovalId']).toBe(approvalId);
    expect(events.some((e) => e.type === SSE_EVENT_TYPE.DONE)).toBe(false);

    // ② 批准（12 处置语义）→ resume 续跑：新鲜度校验通过 → mock 发送 → 回写 → 排期第 2 步
    await db
      .update(schema.approvalRequest)
      .set({ status: 'approved', decidedAt: new Date() })
      .where(eq(schema.approvalRequest.id, approvalId));
    const resumed = await runner.run(taskId, { resume: { nodeId: 'email_send', approvalId } });
    expect(resumed.status).toBe('completed');

    // 邮件落库（message out/sent）+ 执行记录（sent，锚定策略步 1）
    const msgs = await db
      .select({ id: schema.message.id, direction: schema.message.direction, status: schema.message.status })
      .from(schema.message)
      .where(eq(schema.message.conversationId, CONV));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].direction).toBe('out');
    expect(msgs[0].status).toBe('sent');
    const execs = await db
      .select({ status: schema.followUpExecution.status, stepId: schema.followUpExecution.strategyStepId })
      .from(schema.followUpExecution)
      .where(eq(schema.followUpExecution.followUpTaskId, FT));
    expect(execs).toHaveLength(1);
    expect(execs[0].status).toBe('sent');
    expect(execs[0].stepId).toBe(STRATEGY_STEP_1);

    // 跟进任务 → scheduled，nextRunAt 已按第 2 步排期（> 挂起前冻结值）
    const [ft2] = await db
      .select({ status: schema.followUpTask.status, nextRunAt: schema.followUpTask.nextRunAt })
      .from(schema.followUpTask)
      .where(eq(schema.followUpTask.id, FT));
    expect(ft2.status).toBe('scheduled');
    expect((ft2.nextRunAt as Date).getTime()).toBeGreaterThan(frozenAt.getTime());
    // 14 §1.2 类型化 outputs：draft + insight（触达记录 + 排期）
    const draftOut = resumed.outputs?.find((o) => o?.['type'] === 'draft');
    expect((draftOut?.['payload'] as Record<string, unknown>)['subject']).toBeTruthy();
    const insightOut = resumed.outputs?.find((o) => o?.['type'] === 'insight');
    expect(insightOut?.['payload']).toMatchObject({ nextStep: { seq: 2 } });

    // 终态收口：任务 completed + 员工 idle + done 事件
    const [task2] = await db.select({ status: schema.aiTask.status }).from(schema.aiTask).where(eq(schema.aiTask.id, taskId));
    expect(task2.status).toBe('completed');
    const [emp2] = await db.select({ status: schema.aiEmployee.status }).from(schema.aiEmployee).where(eq(schema.aiEmployee.id, EMP_FU));
    expect(emp2.status).toBe('idle');
    await waitUntil(events, (e) => e.type === SSE_EVENT_TYPE.DONE && e.payload?.['status'] === 'completed');
  });

  it('客户已回复撞车防护：check_replied → 转人工暂停', async () => {
    // uq_ftask_org_customer_strategy：同 org/customer/strategy 仅一条跟进任务 →
    // 撞车用例独立客户（CUSTOMER2），其在任务创建后有一条 in 消息 → 第二个跟进任务应直接 paused
    const customer2 = createId('cus');
    const ft2 = createId('ftask');
    const conv2 = createId('conv');
    await db.transaction(async (tx) => {
      await tx.insert(schema.customer).values({
        id: customer2,
        orgId: ORG,
        companyName: '撞车测试客户',
        country: 'US',
        ownerId: USER,
      });
      await tx.insert(schema.followUpTask).values({
        id: ft2,
        orgId: ORG,
        customerId: customer2,
        strategyId: STRATEGY,
        status: 'ready',
        nextRunAt: new Date(),
      });
      await tx.insert(schema.conversation).values({ id: conv2, orgId: ORG, customerId: customer2, channel: 'email', subject: '撞车会话' });
      await tx.insert(schema.message).values({
        id: createId('msg'),
        orgId: ORG,
        conversationId: conv2,
        direction: 'in',
        senderType: 'contact',
        senderName: '客户',
        content: 'We are interested, please send a quote.',
        status: 'sent',
        language: 'en',
        sentAt: new Date(),
        createdAt: new Date(),
      });
    });
    const taskId = createId('task');
    await db.insert(schema.aiTask).values({
      id: taskId,
      orgId: ORG,
      employeeId: EMP_FU,
      type: 'follow_up',
      title: 'M3 撞车防护',
      status: 'scheduled',
      input: { followUpTaskId: ft2, customerId: customer2, conversationId: conv2 },
    });

    const result = await runner.run(taskId);
    expect(result.status).toBe('completed');
    const [ft] = await db.select({ status: schema.followUpTask.status }).from(schema.followUpTask).where(eq(schema.followUpTask.id, ft2));
    expect(ft.status).toBe('paused');
    // 无任何外发消息新增（既有 out 消息仅前一用例批准后发送的 1 条）
    const msgs = await db
      .select({ id: schema.message.id })
      .from(schema.message)
      .where(and(eq(schema.message.orgId, ORG), eq(schema.message.direction, 'out')));
    expect(msgs).toHaveLength(1);
  });
});

/**
 * M4-1 lead_hunting 专项集成用例：阈值映射 / 硬过滤 / 轮次守卫 / 额度 paused。
 * mock 契约（llm-gateway mockStructured + search-tools mock 池，确定性可复算）：
 * - matchPct = 82（mockNumber 'pct'），LLM scoreLevel 枚举首位 = 'high'（仅参考，落库以 mapScoreLevel 为准）；
 * - 搜索词 = 'carbon fiber insoles manufacturer USA'（len 37），第 n 轮域名 vendor-r{n}-37.example.com
 *   （同轮公司名相同、域名随轮次变化，跨轮去重以域名为键）；
 * - employeeCount = 40 + ((round*97 + 37*13) % 460) < 1000（companySizeRange 硬过滤可测）；
 * - 每完整轮外部配额：web_search 1 + site_crawl 2 + lookup_contact 1 = 4（find_contact/knowledge_search 计 0）。
 * 各用例独立 org（发现池查重按 org 隔离），用例间无耦合。
 */
describe('M4-1 lead_hunting：阈值映射 / 硬过滤 / 轮次守卫 / 额度 paused', () => {
  const ORG2 = createId('org');
  const ORG3 = createId('org');
  const ORG4 = createId('org');
  const EMP2 = createId('aie');
  const EMP3 = createId('aie');
  const EMP_QUOTA = createId('aie');
  const LEAD_TOOLS = ['web_search', 'site_crawl', 'find_contact', 'lookup_contact', 'crm_write', 'knowledge_search'];

  const MOCK_QUERY = 'carbon fiber insoles manufacturer USA';

  async function seedOrg(orgId: string, employees: { id: string; permissions?: Record<string, unknown> }[]): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.insert(schema.org).values({ id: orgId, name: `M4-1-${orgId.slice(-4)}`, timezone: 'Asia/Shanghai' });
      for (const [i, emp] of employees.entries()) {
        await tx.insert(schema.userAccount).values({
          id: createId('usr'),
          orgId,
          email: `m41-${orgId.slice(-6)}-${i}@test.com`,
          passwordHash: 'x',
          name: '测试管理员',
          role: 'admin',
          status: 'active',
        });
        await tx.insert(schema.aiEmployee).values({
          id: emp.id,
          orgId,
          role: 'lead_hunter',
          name: '获客员',
          goal: '完成获客目标',
          tools: LEAD_TOOLS,
          permissions: emp.permissions ?? {},
          approvalPolicy: { email_send: 'high_value_only', quote: 'always', autoExecute: [] },
          kpiConfig: [{ metric: 'leads', target: 5, period: 'daily' }],
        });
      }
    });
  }

  async function runLeadTask(orgId: string, employeeId: string, input: Record<string, unknown>): Promise<string> {
    const taskId = createId('task');
    await db.insert(schema.aiTask).values({
      id: taskId,
      orgId,
      employeeId,
      type: 'lead_hunting',
      title: 'M4-1 获客用例',
      status: 'scheduled',
      input,
    });
    const result = await runner.run(taskId);
    expect(result.status).toBe('completed');
    return taskId;
  }

  beforeAll(async () => {
    await seedOrg(ORG2, [{ id: EMP2 }]);
    await seedOrg(ORG3, [{ id: EMP3 }]);
    await seedOrg(ORG4, [{ id: EMP_QUOTA, permissions: { externalCallDailyLimit: 4 } }]);
  });

  afterAll(async () => {
    const orgIds = [ORG2, ORG3, ORG4];
    await db.transaction(async (tx) => {
      for (const orgId of orgIds) {
        await tx.delete(schema.llmCall).where(eq(schema.llmCall.orgId, orgId));
        await tx.delete(schema.aiTaskLog).where(eq(schema.aiTaskLog.orgId, orgId));
        await tx.delete(schema.aiTaskStep).where(eq(schema.aiTaskStep.orgId, orgId));
        await tx.delete(schema.aiLeadContact).where(eq(schema.aiLeadContact.orgId, orgId));
        await tx.delete(schema.aiLead).where(eq(schema.aiLead.orgId, orgId));
        // 审批闭环留痕（follow_up 场景的 email_send 审批单）
        await tx.delete(schema.approvalLog).where(eq(schema.approvalLog.orgId, orgId));
        await tx.delete(schema.approvalRequest).where(eq(schema.approvalRequest.orgId, orgId));
        await tx.delete(schema.aiTask).where(eq(schema.aiTask.orgId, orgId));
        // 跟进链路（漏删会跨文件污染 scheduler 扫描：scanner 跨租户扫所有到期 follow_up_task）
        await tx.delete(schema.followUpExecution).where(eq(schema.followUpExecution.orgId, orgId));
        await tx.delete(schema.followUpTask).where(eq(schema.followUpTask.orgId, orgId));
        await tx.delete(schema.followUpStrategyStep).where(eq(schema.followUpStrategyStep.orgId, orgId));
        await tx.delete(schema.followUpStrategy).where(eq(schema.followUpStrategy.orgId, orgId));
        await tx.delete(schema.message).where(eq(schema.message.orgId, orgId));
        await tx.delete(schema.conversation).where(eq(schema.conversation.orgId, orgId));
        await tx.delete(schema.customerActivity).where(eq(schema.customerActivity.orgId, orgId));
        await tx.delete(schema.customer).where(eq(schema.customer.orgId, orgId));
        await tx.delete(schema.aiEmployee).where(eq(schema.aiEmployee.orgId, orgId));
        await tx.delete(schema.userAccount).where(eq(schema.userAccount.orgId, orgId));
        await tx.delete(schema.org).where(eq(schema.org.id, orgId));
      }
    });
    // 配额键（quota:{org}:{emp}:{day} + M4 org 级搜索/抓取键）清理，防跨套件残留
    for (const orgId of orgIds) {
      const keys = await redis.keys(`quota:${orgId}:*`);
      const orgSearchKeys = await redis.keys(`orgsearch:${orgId}:*`);
      const allKeys = [...keys, ...orgSearchKeys];
      if (allKeys.length > 0) {
        await redis.del(...allKeys);
      }
    }
  });

  it('阈值映射：matchThresholds 确定性覆写 LLM scoreLevel（90/80 → medium；80/50 → high）', async () => {
    // LLM 恒输出 matchPct=82 + scoreLevel='high'（mock 枚举首位，仅参考）
    // 自定义 90/80：82 < 90 且 ≥ 80 → 落库 medium（覆写 LLM 的 high）
    const taskA = await runLeadTask(ORG2, EMP2, {
      goal: '寻找美国机械零件采购商',
      targetCount: 1,
      advancedSettings: { matchThresholds: { high: 90, medium: 80 } },
    });
    const [leadA] = await db
      .select({ matchPct: schema.aiLead.matchPct, scoreLevel: schema.aiLead.scoreLevel })
      .from(schema.aiLead)
      .where(eq(schema.aiLead.taskId, taskA));
    expect(leadA.matchPct).toBe(82);
    expect(leadA.scoreLevel).toBe('medium');

    // 自定义 80/50：82 ≥ 80 → 落库 high（证明阈值取自 advancedSettings 而非默认 85/60）
    const taskB = await runLeadTask(ORG2, EMP2, {
      goal: '寻找美国机械零件采购商',
      targetCount: 1,
      advancedSettings: { matchThresholds: { high: 80, medium: 50 } },
    });
    const [leadB] = await db
      .select({ scoreLevel: schema.aiLead.scoreLevel })
      .from(schema.aiLead)
      .where(eq(schema.aiLead.taskId, taskB));
    expect(leadB.scoreLevel).toBe('high');
  });

  it('阈值映射：低于 medium 分档线走 low 分支，跳过联系人发现', async () => {
    const taskId = await runLeadTask(ORG2, EMP2, {
      goal: '寻找美国机械零件采购商',
      targetCount: 1,
      advancedSettings: { matchThresholds: { high: 100, medium: 90 } },
    });
    const [lead] = await db
      .select({ id: schema.aiLead.id, scoreLevel: schema.aiLead.scoreLevel })
      .from(schema.aiLead)
      .where(eq(schema.aiLead.taskId, taskId));
    expect(lead.scoreLevel).toBe('low');
    // low 分支不进入 find_contact/lookup_contact → 无联系人落库
    const contacts = await db
      .select({ id: schema.aiLeadContact.id })
      .from(schema.aiLeadContact)
      .where(eq(schema.aiLeadContact.leadId, lead.id));
    expect(contacts).toHaveLength(0);
  });

  it('硬过滤：companySizeRange + excludeDomains 全排除 → maxRounds 收敛零写入', async () => {
    // 员工数恒 < 1000 → companySizeRange.min 过滤全部轮次；excludeDomains 兜底第 1 轮精确域名
    const domainRound1 = `vendor-r1-${MOCK_QUERY.length}.example.com`;
    const taskId = await runLeadTask(ORG2, EMP2, {
      goal: '寻找美国机械零件采购商',
      targetCount: 1,
      advancedSettings: {
        companySizeRange: { min: 1000 },
        excludeDomains: [domainRound1],
        maxRounds: 2,
      },
    });
    const [task] = await db.select({ status: schema.aiTask.status }).from(schema.aiTask).where(eq(schema.aiTask.id, taskId));
    expect(task.status).toBe('completed');
    const leads = await db.select({ id: schema.aiLead.id }).from(schema.aiLead).where(eq(schema.aiLead.taskId, taskId));
    expect(leads).toHaveLength(0); // 03 §3.6：全部候选被硬过滤 → 零写入收尾
  });

  it('轮次守卫：target 不可达时 maxRounds 兜底收敛（2 轮后 save）', async () => {
    const taskId = await runLeadTask(ORG3, EMP3, {
      goal: '寻找美国机械零件采购商',
      targetCount: 5, // mock 每轮仅产出 1 家 → 不可达，验证 maxRounds=2 截停
      advancedSettings: { maxRounds: 2 },
    });
    const [task] = await db
      .select({ status: schema.aiTask.status, progressPct: schema.aiTask.progressPct })
      .from(schema.aiTask)
      .where(eq(schema.aiTask.id, taskId));
    expect(task.status).toBe('completed');
    expect(task.progressPct).toBe(100);
    const leads = await db.select({ id: schema.aiLead.id }).from(schema.aiLead).where(eq(schema.aiLead.taskId, taskId));
    expect(leads).toHaveLength(2); // 每轮 1 家 × 2 轮
    const searchLogs = await db
      .select({ content: schema.aiTaskLog.content })
      .from(schema.aiTaskLog)
      .where(
        and(
          eq(schema.aiTaskLog.taskId, taskId),
          eq(schema.aiTaskLog.type, 'search'),
          // 仅统计工具轮次日志（plan_search LLM 节点 logType 同为 'search'）
          sql`${schema.aiTaskLog.content} like '第 % 轮搜索%'`,
        ),
      )
      .orderBy(asc(schema.aiTaskLog.occurredAt));
    expect(searchLogs.map((l) => l.content)).toEqual(['第 1 轮搜索：' + MOCK_QUERY, '第 2 轮搜索：' + MOCK_QUERY]);
  });

  it('额度耗尽：42901 → 任务 paused 而非 failed，错误日志落库 + SSE 推送', async () => {
    // ORG4 全新（无发现池残留）：限 4 → 第 1 轮完整跑（web1+crawl2+lookup1=4）
    // → 第 2 轮 web_search INCR 后 5 > 4 → RATE_LIMITED → paused（03 §3.7）
    const taskId = createId('task');
    await db.insert(schema.aiTask).values({
      id: taskId,
      orgId: ORG4,
      employeeId: EMP_QUOTA,
      type: 'lead_hunting',
      title: 'M4-1 额度 paused',
      status: 'scheduled',
      input: { goal: '寻找美国机械零件采购商', targetCount: 5 },
    });
    const events = await collectEvents(redis, taskId);
    const result = await runner.run(taskId);
    expect(result.status).toBe(TASK_STATUS.PAUSED);

    const [task] = await db
      .select({ status: schema.aiTask.status, finishedAt: schema.aiTask.finishedAt })
      .from(schema.aiTask)
      .where(eq(schema.aiTask.id, taskId));
    expect(task.status).toBe(TASK_STATUS.PAUSED);
    expect(task.finishedAt).toBeNull(); // paused 非终态，次日额度重置后可 resume

    // error 日志落库（03 §3.7）
    const [errLog] = await db
      .select({ content: schema.aiTaskLog.content })
      .from(schema.aiTaskLog)
      .where(and(eq(schema.aiTaskLog.taskId, taskId), eq(schema.aiTaskLog.type, 'error')));
    expect(errLog.content).toContain('额度');

    // paused 在 save 之前中断 → 本任务无发现池写入
    const leads = await db.select({ id: schema.aiLead.id }).from(schema.aiLead).where(eq(schema.aiLead.taskId, taskId));
    expect(leads).toHaveLength(0);

    // SSE：status=paused 事件推送（无 done 事件）
    await waitUntil(events, (e) => e.type === SSE_EVENT_TYPE.STATUS && e.payload?.['status'] === TASK_STATUS.PAUSED);
    const statusEvt = events.find((e) => e.type === SSE_EVENT_TYPE.STATUS && e.payload?.['status'] === TASK_STATUS.PAUSED);
    expect(statusEvt?.payload?.['error']).toContain('额度');
    expect(events.some((e) => e.type === SSE_EVENT_TYPE.DONE)).toBe(false);
  });
});
