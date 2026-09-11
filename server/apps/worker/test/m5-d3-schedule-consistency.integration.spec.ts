/**
 * M5-D3 外发规则生效链路端到端一致性（后端开发计划表 D3，M5 #9）：
 * - org.send_rules（sendWindow 全天）驱动「图内 schedule_next」落点；
 * - 断言 schedule_next 写回 follow_up_task.next_run_at 与 @tradepilot/core 唯一公式
 *   computeDeferredNextRunAt 的输出完全一致（P1-4 收口：候选 = max(策略基准+dayOffset,
 *   L+minTouchIntervalDays) → org.timezone 窗口对齐）；
 * - dayOffset 绑定：无外发且下一步在远期 → 落点 = 任务创建基准 + dayOffset。
 * - 链路端到端走真实外发（GreenMail + 真实 LLM），故「近 interval 内有外发」场景会先被
 *   email_send 频控拒发（无法既真实发送又命中间隔绑定），该分支公式一致性改由
 *   scheduler.integration.spec.ts（Scanner 频控预检）覆盖；两文件合起来证明 send_rules
 *   → Scheduler 预检 → 图内 schedule_next 三处落点共用同一公式。
 * 前置：docker compose up（PG 5432 / Redis 6379 + GreenMail 1025/1114）+ `pnpm --filter @tradepilot/db migrate`。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Redis as IORedis, type Redis } from 'ioredis';
import pino from 'pino';
import { z } from 'zod';
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
import { computeDeferredNextRunAt, createId } from '@tradepilot/core';
import { configureEmailSend, createToolRegistry } from '@tradepilot/tools';
import {
  copilotSchema,
  createFlowRegistry,
  createPromptRegistry,
  followUpContentSchema,
  intentSchema,
  leadScoreSchema,
  parsedGoalSchema,
  searchPlanSchema,
  workflowSopProvider,
} from '@tradepilot/workflows';
import { testLlmOptions, testMailboxRow } from './setup/providers.js';

/** 测试邮箱凭据信封密钥（与写入 mailbox 行时一致；发送瞬间内存解密） */
const KEY = '0'.repeat(64);

const SUPER_URL =
  process.env.TEST_SUPER_DATABASE_URL ??
  'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

const logger = pino({ level: process.env.TEST_LOG_LEVEL ?? 'silent' });

let db: Db;
let redis: Redis;
let runner: TaskRunner;
let stopCheckpointer: () => Promise<void>;

// ===== ORG_D3：send_rules 显式全天窗口 + 7 天频控 =====
const ORG = createId('org');
const ADMIN = createId('usr');
const EMP = createId('aie');
const STRATEGY_OFFSET = createId('fstr');
const STEP_O1 = createId('fstp');
const STEP_O2 = createId('fstp');
const CUS_OFFSET = createId('cus');
const CONV_OFFSET = createId('conv');
const FT_OFFSET = createId('ftask');

// 真实外发依赖：org 级 connected 邮箱（发送方）+ 客户联系人邮箱（收件方）
const MAILBOX = createId('mbx');
const MAIL_ACCOUNT = `m5d3-${ORG.slice(-6)}@test.local`;
const CONTACT_OFFSET = createId('ct');

// 确定性时间锚点：任务创建基准（Day 0）
const BASE = new Date(Date.now() - 10 * 86_400_000);

beforeAll(async () => {
  db = createDb(SUPER_URL, { max: 5 });
  redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

  const checkpointer = await createCheckpointer(SUPER_URL);
  stopCheckpointer = checkpointer.close;
  const publisher = new TaskEventPublisher(redis);
  const gateway = new LlmGateway(db, logger, { ...testLlmOptions });
  const gate = new ApprovalGate(db, redis, publisher, logger);
  // 真实外发唯一出口：注入邮件驱动真实配置（无 mock 兜底），mailbox 行凭据信封随测试密钥
  configureEmailSend({ encryptionKey: KEY, db });

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
      registry.register(
        'draftReply',
        z
          .object({
            subject: z.string().min(1),
            body: z.string().min(1),
            grounded: z.boolean(),
            missingInfo: z.array(z.string()).optional(),
          })
          .strict(),
      );
      registry.register('followUpContent', followUpContentSchema);
      return registry;
    })(),
    checkpointer: checkpointer.saver,
  });
  runner = new TaskRunner({ db, redis, logger, publisher, compiler, sops: workflowSopProvider });

  await db.transaction(async (tx) => {
    await tx.insert(schema.org).values({
      id: ORG,
      name: 'M5-D3 调度一致性租户',
      timezone: 'Asia/Shanghai',
      sendRules: {
        sendWindow: { start: '00:00', end: '24:00' },
        minTouchIntervalDays: 7,
      },
    });
    await tx.insert(schema.userAccount).values({
      id: ADMIN,
      orgId: ORG,
      email: `m5d3-${ORG.slice(-6)}@test.com`,
      passwordHash: 'x',
      name: '测试管理员',
      role: 'admin',
      status: 'active',
    });
    // autoApprove 全开（email_send 场景自动放行，验证「落点」而非审批挂起）
    await tx.insert(schema.rolePermission).values({
      id: createId('rp'),
      orgId: ORG,
      role: 'sales',
      permissions: { customers: 'all', quotes: 'view', approvals: [], settings: 'none' },
      approvalRules: [
        { approvalType: 'email_send', approverRoles: ['manager'], autoApprove: true },
      ],
    });
    await tx.insert(schema.aiEmployee).values({
      id: EMP,
      orgId: ORG,
      role: 'sales',
      name: 'AI 跟进员',
      goal: '按策略跟进客户',
      tools: ['knowledge_search', 'email_send'],
      permissions: {},
      approvalPolicy: {
        email_send: 'high_value_only',
        quote: 'always',
        autoExecute: ['email_send'],
      },
      kpiConfig: [{ metric: 'touches', target: 5, period: 'daily' }],
    });
    // org 级 connected 邮箱（GreenMail；会话未关联邮箱时兜底选用）
    await tx.insert(schema.mailbox).values({
      id: MAILBOX,
      orgId: ORG,
      ownerUserId: null,
      provider: 'smtp_imap',
      account: MAIL_ACCOUNT,
      imap: testMailboxRow(MAIL_ACCOUNT, MAILBOX, ORG, KEY).imap,
      smtp: testMailboxRow(MAIL_ACCOUNT, MAILBOX, ORG, KEY).smtp,
      syncScope: { historyDays: 90, folders: ['INBOX'] },
      status: 'connected',
    });

    // 策略 O（dayOffset 分支）：无外发，下一步 dayOffset=14（远期 → 基准 + 14d）
    await tx
      .insert(schema.followUpStrategy)
      .values([
        {
          id: STRATEGY_OFFSET,
          orgId: ORG,
          name: '节奏策略',
          targetScope: {},
          autoSendPolicy: 'auto_send',
          isDefault: false,
        },
      ]);
    await tx.insert(schema.followUpStrategyStep).values([
      { id: STEP_O1, orgId: ORG, strategyId: STRATEGY_OFFSET, seq: 1, dayOffset: 0, title: '首触' },
      {
        id: STEP_O2,
        orgId: ORG,
        strategyId: STRATEGY_OFFSET,
        seq: 2,
        dayOffset: 14,
        title: '长期跟进',
      },
    ]);

    await tx
      .insert(schema.customer)
      .values([
        { id: CUS_OFFSET, orgId: ORG, companyName: '节奏分支客户', country: 'DE', ownerId: ADMIN },
      ]);
    // 收件方联系人（email_send 由 conversation.contact 解析收件地址）
    await tx.insert(schema.contact).values({
      id: CONTACT_OFFSET,
      orgId: ORG,
      customerId: CUS_OFFSET,
      name: '节奏分支联系人',
      title: '采购经理',
      email: `m5d3-to-${ORG.slice(-6)}@test.local`,
    });
    await tx
      .insert(schema.conversation)
      .values([
        {
          id: CONV_OFFSET,
          orgId: ORG,
          customerId: CUS_OFFSET,
          contactId: CONTACT_OFFSET,
          channel: 'email',
          subject: '节奏分支会话',
        },
      ]);
    await tx.insert(schema.followUpTask).values([
      {
        id: FT_OFFSET,
        orgId: ORG,
        customerId: CUS_OFFSET,
        strategyId: STRATEGY_OFFSET,
        status: 'ready',
        nextRunAt: new Date(),
        createdAt: BASE,
      },
    ]);
  });
}, 30_000);

afterAll(async () => {
  if (ORG) {
    await db.transaction(async (tx) => {
      await tx.delete(schema.llmCall).where(eq(schema.llmCall.orgId, ORG));
      await tx.delete(schema.aiTaskLog).where(eq(schema.aiTaskLog.orgId, ORG));
      await tx.delete(schema.aiTaskStep).where(eq(schema.aiTaskStep.orgId, ORG));
      // ai_task.linked_approval_id → approval_request：先删子表（ai_task 持有外键）
      await tx.delete(schema.aiTask).where(eq(schema.aiTask.orgId, ORG));
      await tx.delete(schema.approvalLog).where(eq(schema.approvalLog.orgId, ORG));
      await tx.delete(schema.approvalRequest).where(eq(schema.approvalRequest.orgId, ORG));
      await tx.delete(schema.followUpExecution).where(eq(schema.followUpExecution.orgId, ORG));
      await tx.delete(schema.followUpTask).where(eq(schema.followUpTask.orgId, ORG));
      await tx
        .delete(schema.followUpStrategyStep)
        .where(eq(schema.followUpStrategyStep.orgId, ORG));
      await tx.delete(schema.followUpStrategy).where(eq(schema.followUpStrategy.orgId, ORG));
      await tx.delete(schema.conversationInsight).where(eq(schema.conversationInsight.orgId, ORG));
      await tx.delete(schema.customerInsight).where(eq(schema.customerInsight.orgId, ORG));
      await tx.delete(schema.message).where(eq(schema.message.orgId, ORG));
      await tx.delete(schema.conversation).where(eq(schema.conversation.orgId, ORG));
      await tx.delete(schema.contact).where(eq(schema.contact.orgId, ORG));
      await tx.delete(schema.customerActivity).where(eq(schema.customerActivity.orgId, ORG));
      await tx.delete(schema.customer).where(eq(schema.customer.orgId, ORG));
      await tx.delete(schema.mailbox).where(eq(schema.mailbox.orgId, ORG));
      await tx.delete(schema.rolePermission).where(eq(schema.rolePermission.orgId, ORG));
      await tx.delete(schema.aiEmployee).where(eq(schema.aiEmployee.orgId, ORG));
      await tx.delete(schema.userAccount).where(eq(schema.userAccount.orgId, ORG));
      await tx.delete(schema.org).where(eq(schema.org.id, ORG));
    });
  }
  await closeDb(db);
  await stopCheckpointer();
  redis.disconnect();
});

async function insertFollowUpTask(
  ftId: string,
  customerId: string,
  conversationId: string,
): Promise<string> {
  const taskId = createId('task');
  await db.insert(schema.aiTask).values({
    id: taskId,
    orgId: ORG,
    employeeId: EMP,
    type: 'follow_up',
    title: 'M5-D3 跟进触达',
    status: 'scheduled',
    input: { followUpTaskId: ftId, customerId, conversationId },
  });
  return taskId;
}

async function readNextRunAt(ftId: string): Promise<Date> {
  const [ft] = await db
    .select({ nextRunAt: schema.followUpTask.nextRunAt, status: schema.followUpTask.status })
    .from(schema.followUpTask)
    .where(eq(schema.followUpTask.id, ftId));
  return ft?.nextRunAt as Date;
}

describe('M5-D3 · send_rules → 图内 schedule_next 落点一致性（org.timezone + 全天窗口）', () => {
  it('dayOffset 分支：无外发 + 远期下一步 → next_run_at = 任务创建基准 + 14d，与唯一公式一致', async () => {
    const taskId = await insertFollowUpTask(FT_OFFSET, CUS_OFFSET, CONV_OFFSET);
    const result = await runner.run(taskId);
    expect(result.status).toBe('completed');

    const [ft] = await db
      .select({ createdAt: schema.followUpTask.createdAt })
      .from(schema.followUpTask)
      .where(eq(schema.followUpTask.id, FT_OFFSET));
    const base = ft?.createdAt as Date;

    const actual = await readNextRunAt(FT_OFFSET);
    const expected = computeDeferredNextRunAt({
      now: new Date(),
      nextRunAt: new Date(base.getTime() + 14 * 86_400_000),
      lastOutboundAt: null,
      minTouchIntervalDays: 7,
      timeZone: 'Asia/Shanghai',
      window: { startHour: 0, endHour: 24 },
    });
    expect(actual.getTime()).toBe(expected.getTime());
    expect(actual.getTime()).toBe(base.getTime() + 14 * 86_400_000);
    expect(actual.getTime()).toBeGreaterThan(Date.now());
  });
});
