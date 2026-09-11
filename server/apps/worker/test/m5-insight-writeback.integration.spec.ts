import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { Redis as IORedis, type Redis } from 'ioredis';
import pino from 'pino';
import {
  ApprovalGate,
  GraphCompiler,
  LlmGateway,
  SimpleOutputSchemaRegistry,
  TaskEventPublisher,
  TaskRunner,
  createCheckpointer,
} from '@tradepilot/runtime';
import { closeDb, createDb, schema, type Db } from '@tradepilot/db';
import { createId } from '@tradepilot/core';
import { createToolRegistry } from '@tradepilot/tools';
import {
  copilotSchema,
  createFlowRegistry,
  createPromptRegistry,
  intentSchema,
  leadScoreSchema,
  parsedGoalSchema,
  searchPlanSchema,
  workflowSopProvider,
} from '@tradepilot/workflows';
import { testLlmOptions } from './setup/providers.js';

/**
 * M5-C4 洞察写回专项（后端开发计划表 M5 #10 / C4）：
 * - product_analysis（customer 360 /customers/{id}/analyze 场景）：copilot 分析产出 →
 *   customer_insight 落表（uq_customer_insight_type upsert，insightType=purchase_probability，
 *   value=概率、reasons=推荐动作、taskId 溯源）；
 * - product_analysis（03 /leads/batch-analyze 场景）：ai_lead 非 customer（FK 约束），
 *   不落 customer_insight，分析对象随类型化 outputs（insight）留存；
 * - 幂等：同客户二次分析 upsert 覆盖（唯一键冲突走 onConflictDoUpdate）。
 * 前置：docker compose up（PG 5432 / Redis 6379）+ `pnpm --filter @tradepilot/db migrate`。
 */

const SUPER_URL =
  process.env.TEST_SUPER_DATABASE_URL ??
  'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

const logger = pino({ level: process.env.TEST_LOG_LEVEL ?? 'silent' });

let db: Db;
let redis: Redis;
let runner: TaskRunner;
let stopCheckpointer: () => Promise<void>;

const ORG = createId('org');
const EMP = createId('aie');
const CUS = createId('cus');
const LEAD_A = createId('lead');
const LEAD_B = createId('lead');

beforeAll(async () => {
  db = createDb(SUPER_URL, { max: 5 });
  redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

  const checkpointer = await createCheckpointer(SUPER_URL);
  stopCheckpointer = checkpointer.close;
  const publisher = new TaskEventPublisher(redis);
  const gateway = new LlmGateway(db, logger, { ...testLlmOptions });
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
    outputSchemas: ((): SimpleOutputSchemaRegistry => {
      const registry = new SimpleOutputSchemaRegistry();
      registry.register('parsedGoal', parsedGoalSchema);
      registry.register('searchPlan', searchPlanSchema);
      registry.register('leadScore', leadScoreSchema);
      registry.register('intent', intentSchema);
      registry.register('copilot', copilotSchema);
      return registry;
    })(),
    checkpointer: checkpointer.saver,
  });
  runner = new TaskRunner({ db, redis, logger, publisher, compiler, sops: workflowSopProvider });

  await db.transaction(async (tx) => {
    await tx.insert(schema.org).values({ id: ORG, name: 'M5-C4 租户', timezone: 'Asia/Shanghai' });
    const admin = createId('usr');
    await tx.insert(schema.userAccount).values({
      id: admin,
      orgId: ORG,
      email: `m5c4-${ORG.slice(-6)}@test.com`,
      passwordHash: 'x',
      name: '测试管理员',
      role: 'admin',
      status: 'active',
    });
    await tx.insert(schema.aiEmployee).values({
      id: EMP,
      orgId: ORG,
      role: 'customer_researcher',
      name: 'AI 客户研究员',
      goal: '分析客户购买意向',
      tools: [],
      permissions: {},
      approvalPolicy: { email_send: 'high_value_only', quote: 'always', autoExecute: [] },
      kpiConfig: [{ metric: 'insights', target: 10, period: 'daily' }],
    });
    await tx.insert(schema.customer).values({
      id: CUS,
      orgId: ORG,
      companyName: '洞察写回客户',
      country: 'DE',
      industry: 'sports',
      ownerId: admin,
    });
    await tx.insert(schema.aiLead).values([
      {
        id: LEAD_A,
        orgId: ORG,
        companyName: '发现池客户 A',
        country: 'US',
        matchPct: 90,
        scoreLevel: 'high',
        insight: {},
      },
      {
        id: LEAD_B,
        orgId: ORG,
        companyName: '发现池客户 B',
        country: 'FR',
        matchPct: 70,
        scoreLevel: 'medium',
        insight: {},
      },
    ]);
  });
});

afterAll(async () => {
  // 子表先行（conversation_insight/customer_insight FK → conversation/customer/ai_task）
  await db.transaction(async (tx) => {
    await tx.delete(schema.customerInsight).where(eq(schema.customerInsight.orgId, ORG));
    await tx.delete(schema.conversationInsight).where(eq(schema.conversationInsight.orgId, ORG));
    await tx.delete(schema.llmCall).where(eq(schema.llmCall.orgId, ORG));
    await tx.delete(schema.aiTaskLog).where(eq(schema.aiTaskLog.orgId, ORG));
    await tx.delete(schema.aiTaskStep).where(eq(schema.aiTaskStep.orgId, ORG));
    await tx.delete(schema.aiTask).where(eq(schema.aiTask.orgId, ORG));
    await tx
      .delete(schema.aiLead)
      .where(and(eq(schema.aiLead.orgId, ORG), inArray(schema.aiLead.id, [LEAD_A, LEAD_B])));
    await tx.delete(schema.customer).where(eq(schema.customer.orgId, ORG));
    await tx.delete(schema.aiEmployee).where(eq(schema.aiEmployee.orgId, ORG));
    await tx.delete(schema.userAccount).where(eq(schema.userAccount.orgId, ORG));
    await tx.delete(schema.org).where(eq(schema.org.id, ORG));
  });
  await closeDb(db);
  await stopCheckpointer();
  redis.disconnect();
});

async function insertTask(input: Record<string, unknown>): Promise<string> {
  const taskId = createId('task');
  await db.insert(schema.aiTask).values({
    id: taskId,
    orgId: ORG,
    employeeId: EMP,
    type: 'product_analysis',
    title: '客户购买意向分析',
    input,
  });
  return taskId;
}

describe('M5-C4 洞察写回：product_analysis → customer_insight / outputs', () => {
  it('customerId 场景：copilot 分析 → customer_insight 落表（purchase_probability + taskId 溯源）', async () => {
    const taskId = await insertTask({ customerId: CUS, action: 'analyze' });

    const result = await runner.run(taskId);
    expect(result.status).toBe('completed');

    const [ins] = await db
      .select()
      .from(schema.customerInsight)
      .where(
        and(
          eq(schema.customerInsight.customerId, CUS),
          eq(schema.customerInsight.insightType, 'purchase_probability'),
        ),
      );
    expect(ins).toBeTruthy();
    expect(ins.taskId).toBe(taskId);
    expect(Number(ins.value)).toBeGreaterThanOrEqual(0);
    expect(Number(ins.value)).toBeLessThanOrEqual(100);
    expect(ins.reasons.length).toBeGreaterThan(0);
    // nextAction = 首条推荐动作（follow_up 语义）
    expect(ins.nextAction).toBeTruthy();
    expect(ins.nextAction?.['label']).toBeTruthy();

    // 类型化 outputs：insight（copilot + customerId）
    const outputs = result.outputs ?? [];
    const insight = outputs.find((o) => o['type'] === 'insight')?.['payload'] as Record<
      string,
      unknown
    >;
    expect(insight).toBeTruthy();
    expect(insight['customerId']).toBe(CUS);
    expect(
      (insight['copilot'] as Record<string, unknown>)['purchaseProbability'],
    ).toBeGreaterThanOrEqual(0);
  });

  it('同客户重复分析：uq_customer_insight_type upsert 覆盖（不产生第二行）', async () => {
    const taskId = await insertTask({ customerId: CUS, action: 'analyze' });
    const result = await runner.run(taskId);
    expect(result.status).toBe('completed');

    const rows = await db
      .select({ id: schema.customerInsight.id, taskId: schema.customerInsight.taskId })
      .from(schema.customerInsight)
      .where(
        and(
          eq(schema.customerInsight.customerId, CUS),
          eq(schema.customerInsight.insightType, 'purchase_probability'),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.taskId).toBe(taskId); // 溯源指向最新分析任务
  });

  it('leadIds 批量场景：ai_lead 非 customer 不落 customer_insight，对象随 outputs 留存', async () => {
    const taskId = await insertTask({ leadIds: [LEAD_A, LEAD_B], action: 'batch_analyze' });
    const result = await runner.run(taskId);
    expect(result.status).toBe('completed');

    // 分析对象进入 outputs（targets 两个 lead 快照）
    const outputs = result.outputs ?? [];
    const insight = outputs.find((o) => o['type'] === 'insight')?.['payload'] as Record<
      string,
      unknown
    >;
    expect(insight).toBeTruthy();
    expect(insight['customerId']).toBeUndefined();
    expect((insight['targets'] as unknown[]).length).toBe(2);

    // 未产生该任务溯源的 customer_insight
    const rows = await db
      .select({ id: schema.customerInsight.id })
      .from(schema.customerInsight)
      .where(eq(schema.customerInsight.taskId, taskId));
    expect(rows).toHaveLength(0);
  });
});
