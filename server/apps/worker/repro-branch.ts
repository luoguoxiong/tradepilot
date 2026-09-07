import pino from 'pino';
import { Redis as IORedis } from 'ioredis';
import { eq } from 'drizzle-orm';
import {
  ApprovalGate,
  GraphCompiler,
  LlmGateway,
  TaskEventPublisher,
  createCheckpointer,
} from '@tradepilot/runtime';
import { closeDb, createDb, schema, type Db } from '@tradepilot/db';
import { createId } from '@tradepilot/core';
import { createToolRegistry } from '@tradepilot/tools';
import {
  createFlowRegistry,
  createOutputSchemaRegistry,
  createPromptRegistry,
  workflowSopProvider,
} from '@tradepilot/workflows';

const logger = pino({ level: 'warn' });
const URL_ = 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';

async function main(): Promise<void> {
  const db: Db = createDb(URL_, { max: 2 });
  const redis = new IORedis('redis://localhost:6380');
  const checkpointer = await createCheckpointer(URL_);
  const publisher = new TaskEventPublisher(redis);
  const compiler = new GraphCompiler({
    db,
    redis,
    logger,
    publisher,
    gateway: new LlmGateway(db, logger, { provider: 'mock', defaultModel: 'mock-1' }),
    gate: new ApprovalGate(db, redis, publisher, logger),
    tools: createToolRegistry(),
    flows: createFlowRegistry(),
    prompts: createPromptRegistry(),
    outputSchemas: createOutputSchemaRegistry(),
    checkpointer: checkpointer.saver,
  });

  const ORG = createId('org');
  const USER = createId('usr');
  const EMP = createId('aie');
  const CUS = createId('cus');
  const STRAT = createId('fstr');
  const S1 = createId('fstp');
  const S2 = createId('fstp');
  const FT = createId('ftask');
  const CONV = createId('conv');
  const TASK = createId('task');

  await db.transaction(async (tx) => {
    await tx.insert(schema.org).values({ id: ORG, name: 'repro', timezone: 'Asia/Shanghai' });
    await tx.insert(schema.userAccount).values({
      id: USER,
      orgId: ORG,
      email: `repro-${ORG}@t.com`,
      passwordHash: 'x',
      name: 'r',
      role: 'admin',
      status: 'active',
    });
    await tx.insert(schema.aiEmployee).values({
      id: EMP,
      orgId: ORG,
      role: 'follow_up',
      name: '跟进员',
      goal: 'g',
      tools: ['knowledge_search', 'email_send'],
      permissions: {},
      approvalPolicy: { email_send: 'high_value_only', quote: 'always', autoExecute: [] },
      kpiConfig: [{ metric: 't', target: 1, period: 'daily' }],
    });
    await tx
      .insert(schema.customer)
      .values({ id: CUS, orgId: ORG, companyName: 'repro客户', country: 'US', ownerId: USER });
    await tx.insert(schema.followUpStrategy).values({
      id: STRAT,
      orgId: ORG,
      name: 'r',
      targetScope: {},
      autoSendPolicy: 'manual_review',
    });
    await tx.insert(schema.followUpStrategyStep).values([
      { id: S1, orgId: ORG, strategyId: STRAT, seq: 1, dayOffset: 0, title: '首触' },
      { id: S2, orgId: ORG, strategyId: STRAT, seq: 2, dayOffset: 3, title: '价值' },
    ]);
    await tx.insert(schema.followUpTask).values({
      id: FT,
      orgId: ORG,
      customerId: CUS,
      strategyId: STRAT,
      status: 'ready',
      nextRunAt: new Date(),
    });
    await tx
      .insert(schema.conversation)
      .values({ id: CONV, orgId: ORG, customerId: CUS, channel: 'email', subject: 'r' });
    await tx.insert(schema.aiTask).values({
      id: TASK,
      orgId: ORG,
      employeeId: EMP,
      type: 'follow_up',
      title: 'repro',
      status: 'scheduled',
      input: { followUpTaskId: FT, customerId: CUS, conversationId: CONV },
    });
  });

  const [emp] = await db.select().from(schema.aiEmployee).where(eq(schema.aiEmployee.id, EMP));
  const [orgRow] = await db.select().from(schema.org).where(eq(schema.org.id, ORG));

  const ctx = {
    orgId: ORG,
    taskId: TASK,
    employeeId: EMP,
    nodeId: '',
    taskType: 'follow_up' as const,
    redis,
    logger,
    now: new Date(),
    bag: new Map(),
    events: [],
    db,
    employee: {
      id: emp.id,
      orgId: emp.orgId,
      role: emp.role,
      name: emp.name,
      tools: emp.tools,
      knowledgeScope: emp.knowledgeScope,
      approvalPolicy: emp.approvalPolicy,
      memoryConfig: emp.memoryConfig ?? null,
      externalCallDailyLimit: 200,
    },
    org: {
      id: orgRow.id,
      timezone: orgRow.timezone ?? 'Asia/Shanghai',
      sendRules: orgRow.sendRules ?? null,
      autoApproveTypes: [],
      approvalTtlMsByType: {},
    },
    task: {
      id: TASK,
      title: 'repro',
      input: { followUpTaskId: FT, customerId: CUS, conversationId: CONV },
    },
    progressPct: 0,
    currentStep: '',
  } as never;

  const { sop, stateKeys } = workflowSopProvider.get('follow_up');
  const graph = compiler.compile('follow_up', sop, stateKeys);
  try {
    await graph.invoke(
      {
        taskId: TASK,
        orgId: ORG,
        employeeId: EMP,
        taskType: 'follow_up',
        input: { followUpTaskId: FT, customerId: CUS, conversationId: CONV },
        errors: [],
        followUpTaskId: FT,
        customerId: CUS,
        conversationId: CONV,
      },
      ctx,
    );
    console.log('invoke 完成');
  } catch (err) {
    console.error('invoke 失败 stack:');
    console.error(err instanceof Error ? err.stack : err);
  } finally {
    await db.transaction(async (tx) => {
      await tx.delete(schema.aiTaskLog).where(eq(schema.aiTaskLog.orgId, ORG));
      await tx.delete(schema.aiTaskStep).where(eq(schema.aiTaskStep.orgId, ORG));
      await tx.delete(schema.aiTask).where(eq(schema.aiTask.orgId, ORG));
      await tx.delete(schema.approvalRequest).where(eq(schema.approvalRequest.orgId, ORG));
      await tx.delete(schema.followUpTask).where(eq(schema.followUpTask.orgId, ORG));
      await tx
        .delete(schema.followUpStrategyStep)
        .where(eq(schema.followUpStrategyStep.orgId, ORG));
      await tx.delete(schema.followUpStrategy).where(eq(schema.followUpStrategy.orgId, ORG));
      await tx.delete(schema.conversation).where(eq(schema.conversation.orgId, ORG));
      await tx.delete(schema.customer).where(eq(schema.customer.orgId, ORG));
      await tx.delete(schema.aiEmployee).where(eq(schema.aiEmployee.orgId, ORG));
      await tx.delete(schema.userAccount).where(eq(schema.userAccount.orgId, ORG));
      await tx.delete(schema.org).where(eq(schema.org.id, ORG));
    });
    await checkpointer.close();
    redis.disconnect();
    await closeDb(db);
  }
}

void main();
