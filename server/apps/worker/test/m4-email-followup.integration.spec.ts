import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
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
import { createId } from '@tradepilot/core';
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

/** 测试邮箱凭据信封密钥（与 mailbox 行写入一致；发送瞬间内存解密） */
const KEY = '0'.repeat(64);

/**
 * M4-2 email_reply / M4-3 follow_up 专项集成用例（后端开发计划表 M4 #2/#3）：
 * - email_reply：语言检测 zh/en + 跟随（language 缺失按正文检测，来信 language 写回）、
 *   类型化 outputs（draft+insight）、LLM 记账、M5-C4 洞察写回；grounded 由真实 LLM
 *   依据知识库判定 → 命中 email_send 时审批挂起→批准→resume→真实外发；
 * - follow_up：autoApprove 直发留痕（approval_request auto_approved + approval_log）、
 *   Break-up 强制人工（例外优先于 autoApprove）、策略走完 → follow_up_task completed。
 * 真实依赖：GreenMail 真实邮箱（SMTP 1025 / IMAP 1114）+ 真实 LLM + 真实外发驱动。
 * email_reply 的 grounded 分支由 LLM 决定，非 grounded 断言均与 provider 输出无关。
 * 前置：docker compose up（PG 5432 / Redis 6380 + GreenMail 1025/1114）+ `pnpm --filter @tradepilot/db migrate`。
 */

const SUPER_URL =
  process.env.TEST_SUPER_DATABASE_URL ??
  'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';

const logger = pino({ level: process.env.TEST_LOG_LEVEL ?? 'silent' });

let db: Db;
let redis: Redis;
let runner: TaskRunner;
let stopCheckpointer: () => Promise<void>;

// ===== ORG_ER：email_reply =====
const ORG_ER = createId('org');
const EMP_ER = createId('aie');
const C1 = createId('cus');
const CONV1 = createId('conv');
const MSG_ZH = createId('msg');
const CT1 = createId('ct');
const MBX_ER = createId('mbx');
const ACC_ER = `m42-${ORG_ER.slice(-6)}@test.local`;

// ===== ORG_FU：follow_up =====
const ORG_FU = createId('org');
const EMP_FU = createId('aie');
const SA = createId('fstr');
const SA_STEP_1 = createId('fstp');
const SA_STEP_2 = createId('fstp');
const SB = createId('fstr');
const SB_STEPS = [createId('fstp'), createId('fstp'), createId('fstp')];
const CF1 = createId('cus');
const CF2 = createId('cus');
const CF3 = createId('cus');
const CT_F1 = createId('ct');
const CT_F2 = createId('ct');
const CT_F3 = createId('ct');
const MBX_FU = createId('mbx');
const ACC_FU = `m43-${ORG_FU.slice(-6)}@test.local`;
const FT1 = createId('ftask');
const FT2 = createId('ftask');
const FT3 = createId('ftask');

beforeAll(async () => {
  db = createDb(SUPER_URL, { max: 5 });
  redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

  const checkpointer = await createCheckpointer(SUPER_URL);
  stopCheckpointer = checkpointer.close;
  const publisher = new TaskEventPublisher(redis);
  const gateway = new LlmGateway(db, logger, { ...testLlmOptions });
  const gate = new ApprovalGate(db, redis, publisher, logger);
  // 真实外发唯一出口：注入邮件驱动真实配置（无 mock 兜底）
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
    // ===== email_reply 租户 =====
    const erAdmin = createId('usr');
    await tx
      .insert(schema.org)
      .values({ id: ORG_ER, name: 'M4-2 租户', timezone: 'Asia/Shanghai' });
    await tx.insert(schema.userAccount).values({
      id: erAdmin,
      orgId: ORG_ER,
      email: `m42-${ORG_ER.slice(-6)}@test.com`,
      passwordHash: 'x',
      name: '测试管理员',
      role: 'admin',
      status: 'active',
    });
    await tx.insert(schema.aiEmployee).values({
      id: EMP_ER,
      orgId: ORG_ER,
      role: 'sales',
      name: 'AI 销售员',
      goal: '回复客户邮件',
      tools: ['knowledge_search', 'email_send'],
      permissions: {},
      approvalPolicy: { email_send: 'high_value_only', quote: 'always', autoExecute: [] },
      kpiConfig: [{ metric: 'replies', target: 5, period: 'daily' }],
    });
    // org 级 connected 邮箱（GreenMail；会话未关联邮箱时兜底选用）
    await tx.insert(schema.mailbox).values({
      id: MBX_ER,
      orgId: ORG_ER,
      ownerUserId: null,
      provider: 'smtp_imap',
      account: ACC_ER,
      imap: testMailboxRow(ACC_ER, MBX_ER, ORG_ER, KEY).imap,
      smtp: testMailboxRow(ACC_ER, MBX_ER, ORG_ER, KEY).smtp,
      syncScope: { historyDays: 90, folders: ['INBOX'] },
      status: 'connected',
    });
    await tx
      .insert(schema.customer)
      .values([
        { id: C1, orgId: ORG_ER, companyName: '语言跟随客户', country: 'CN', ownerId: erAdmin },
      ]);
    await tx.insert(schema.contact).values({
      id: CT1,
      orgId: ORG_ER,
      customerId: C1,
      name: '语言跟随联系人',
      title: '采购经理',
      email: `m42-to-${ORG_ER.slice(-6)}@test.local`,
    });
    await tx
      .insert(schema.conversation)
      .values([
        {
          id: CONV1,
          orgId: ORG_ER,
          customerId: C1,
          contactId: CT1,
          channel: 'email',
          subject: '中文询价',
        },
      ]);
    // 触发消息 language=null + 中文正文 → 检测兜底判 zh（06 §7 / M4-2）
    await tx.insert(schema.message).values({
      id: MSG_ZH,
      orgId: ORG_ER,
      conversationId: CONV1,
      direction: 'in',
      senderType: 'contact',
      senderName: '客户',
      content: '您好，我们对贵司的碳纤维鞋垫很感兴趣，请提供最新产品目录和报价。',
      status: 'sent',
      language: null,
      sentAt: new Date(Date.now() - 60_000),
      createdAt: new Date(Date.now() - 60_000),
    });

    // ===== follow_up 租户（autoApprove 全开，验证例外语义）=====
    await tx
      .insert(schema.org)
      .values({ id: ORG_FU, name: 'M4-3 租户', timezone: 'Asia/Shanghai' });
    const fuAdmin = createId('usr');
    await tx.insert(schema.userAccount).values({
      id: fuAdmin,
      orgId: ORG_FU,
      email: `m43-${ORG_FU.slice(-6)}@test.com`,
      passwordHash: 'x',
      name: '测试管理员',
      role: 'admin',
      status: 'active',
    });
    // 员工 role='sales' 同名命中 role_permission（user_role 与 ai_employee_role 同名集）
    await tx.insert(schema.rolePermission).values({
      id: createId('rp'),
      orgId: ORG_FU,
      role: 'sales',
      permissions: { customers: 'all', quotes: 'view', approvals: [], settings: 'none' },
      approvalRules: [
        { approvalType: 'email_send', approverRoles: ['manager'], autoApprove: true },
      ],
    });
    await tx.insert(schema.aiEmployee).values({
      id: EMP_FU,
      orgId: ORG_FU,
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
    await tx.insert(schema.followUpStrategy).values([
      {
        id: SA,
        orgId: ORG_FU,
        name: '两步策略',
        targetScope: {},
        autoSendPolicy: 'auto_send',
        isDefault: false,
      },
      {
        id: SB,
        orgId: ORG_FU,
        name: '三步含 Break-up',
        targetScope: {},
        autoSendPolicy: 'auto_send',
        isDefault: false,
      },
    ]);
    await tx.insert(schema.followUpStrategyStep).values([
      { id: SA_STEP_1, orgId: ORG_FU, strategyId: SA, seq: 1, dayOffset: 0, title: '首触' },
      { id: SA_STEP_2, orgId: ORG_FU, strategyId: SA, seq: 2, dayOffset: 3, title: '价值跟进' },
      {
        id: SB_STEPS[0] as string,
        orgId: ORG_FU,
        strategyId: SB,
        seq: 1,
        dayOffset: 0,
        title: '首触',
      },
      {
        id: SB_STEPS[1] as string,
        orgId: ORG_FU,
        strategyId: SB,
        seq: 2,
        dayOffset: 3,
        title: '价值跟进',
      },
      {
        id: SB_STEPS[2] as string,
        orgId: ORG_FU,
        strategyId: SB,
        seq: 3,
        dayOffset: 7,
        title: 'Break-up',
        isBreakup: true,
      },
    ]);
    // org 级 connected 邮箱（GreenMail；会话未关联邮箱时兜底选用）
    await tx.insert(schema.mailbox).values({
      id: MBX_FU,
      orgId: ORG_FU,
      ownerUserId: null,
      provider: 'smtp_imap',
      account: ACC_FU,
      imap: testMailboxRow(ACC_FU, MBX_FU, ORG_FU, KEY).imap,
      smtp: testMailboxRow(ACC_FU, MBX_FU, ORG_FU, KEY).smtp,
      syncScope: { historyDays: 90, folders: ['INBOX'] },
      status: 'connected',
    });
    await tx.insert(schema.customer).values([
      { id: CF1, orgId: ORG_FU, companyName: '直发客户', country: 'US', ownerId: fuAdmin },
      { id: CF2, orgId: ORG_FU, companyName: 'Break-up 客户', country: 'US', ownerId: fuAdmin },
      { id: CF3, orgId: ORG_FU, companyName: '走完客户', country: 'US', ownerId: fuAdmin },
    ]);
    // 收件方联系人（email_send 由 conversation.contact 解析收件地址）
    await tx.insert(schema.contact).values([
      {
        id: CT_F1,
        orgId: ORG_FU,
        customerId: CF1,
        name: '直发联系人',
        title: '采购经理',
        email: `m43-f1-${ORG_FU.slice(-6)}@test.local`,
      },
      {
        id: CT_F2,
        orgId: ORG_FU,
        customerId: CF2,
        name: 'Break-up 联系人',
        title: '采购经理',
        email: `m43-f2-${ORG_FU.slice(-6)}@test.local`,
      },
      {
        id: CT_F3,
        orgId: ORG_FU,
        customerId: CF3,
        name: '走完联系人',
        title: '采购经理',
        email: `m43-f3-${ORG_FU.slice(-6)}@test.local`,
      },
    ]);
    const contactOf = new Map([
      [CF1, CT_F1],
      [CF2, CT_F2],
      [CF3, CT_F3],
    ]);
    for (const [cid] of [
      [CF1, FT1],
      [CF2, FT2],
      [CF3, FT3],
    ] as const) {
      await tx.insert(schema.conversation).values({
        id: createId('conv'),
        orgId: ORG_FU,
        customerId: cid,
        contactId: contactOf.get(cid),
        channel: 'email',
        subject: '跟进会话',
      });
    }
    const fuConvs = await tx
      .select({ id: schema.conversation.id, customerId: schema.conversation.customerId })
      .from(schema.conversation)
      .where(eq(schema.conversation.orgId, ORG_FU));
    const convOf = new Map(fuConvs.map((c) => [c.customerId, c.id]));
    await tx.insert(schema.followUpTask).values([
      {
        id: FT1,
        orgId: ORG_FU,
        customerId: CF1,
        strategyId: SA,
        status: 'ready',
        nextRunAt: new Date(),
      },
      {
        id: FT2,
        orgId: ORG_FU,
        customerId: CF2,
        strategyId: SB,
        status: 'ready',
        nextRunAt: new Date(),
      },
      {
        id: FT3,
        orgId: ORG_FU,
        customerId: CF3,
        strategyId: SA,
        status: 'ready',
        nextRunAt: new Date(),
      },
    ]);
    // FT2：前两步已 sent → 本次取第 3 步（Break-up）
    await tx.insert(schema.followUpExecution).values([
      {
        id: createId('fexc'),
        orgId: ORG_FU,
        followUpTaskId: FT2,
        strategyStepId: SB_STEPS[0] as string,
        stepTitle: '第 1 步',
        status: 'sent',
        sentAt: new Date(Date.now() - 7 * 86_400_000),
      },
      {
        id: createId('fexc'),
        orgId: ORG_FU,
        followUpTaskId: FT2,
        strategyStepId: SB_STEPS[1] as string,
        stepTitle: '第 2 步',
        status: 'sent',
        sentAt: new Date(Date.now() - 4 * 86_400_000),
      },
      // FT3：首步已 sent → 本次取第 2 步，走完策略
      {
        id: createId('fexc'),
        orgId: ORG_FU,
        followUpTaskId: FT3,
        strategyStepId: SA_STEP_1,
        stepTitle: '第 1 步',
        status: 'sent',
        sentAt: new Date(Date.now() - 4 * 86_400_000),
      },
    ]);
    // 任务 input 需要 conversationId（本次触达容器）
    await tx.update(schema.followUpTask).set({ nextRunAt: new Date() });
    for (const [ftId, cid] of [
      [FT1, CF1],
      [FT2, CF2],
      [FT3, CF3],
    ] as const) {
      await tx.insert(schema.aiTask).values({
        id: createId('task'),
        orgId: ORG_FU,
        employeeId: EMP_FU,
        type: 'follow_up',
        title: '占位（pre-seed）',
        status: 'completed',
        input: { followUpTaskId: ftId, customerId: cid, conversationId: convOf.get(cid) },
        finishedAt: new Date(Date.now() - 86_400_000),
      });
    }
    // 记录 conv 映射供用例使用（存入全局）
    FU_CONV_OF = convOf;
  });
});

let FU_CONV_OF: Map<string, string>;

afterAll(async () => {
  for (const orgId of [ORG_ER, ORG_FU]) {
    await db.transaction(async (tx) => {
      await tx.delete(schema.llmCall).where(eq(schema.llmCall.orgId, orgId));
      await tx.delete(schema.aiTaskLog).where(eq(schema.aiTaskLog.orgId, orgId));
      await tx.delete(schema.aiTaskStep).where(eq(schema.aiTaskStep.orgId, orgId));
      // ai_task.linked_approval_id → approval_request（fk_task_approval）：先删子表
      await tx.delete(schema.aiTask).where(eq(schema.aiTask.orgId, orgId));
      await tx.delete(schema.approvalLog).where(eq(schema.approvalLog.orgId, orgId));
      await tx.delete(schema.approvalRequest).where(eq(schema.approvalRequest.orgId, orgId));
      await tx.delete(schema.followUpExecution).where(eq(schema.followUpExecution.orgId, orgId));
      await tx.delete(schema.followUpTask).where(eq(schema.followUpTask.orgId, orgId));
      await tx
        .delete(schema.followUpStrategyStep)
        .where(eq(schema.followUpStrategyStep.orgId, orgId));
      await tx.delete(schema.followUpStrategy).where(eq(schema.followUpStrategy.orgId, orgId));
      // M5-C4 洞察写回：conversation_insight/customer_insight 先于 conversation/customer 删除
      await tx
        .delete(schema.conversationInsight)
        .where(eq(schema.conversationInsight.orgId, orgId));
      await tx.delete(schema.customerInsight).where(eq(schema.customerInsight.orgId, orgId));
      await tx.delete(schema.message).where(eq(schema.message.orgId, orgId));
      await tx.delete(schema.conversation).where(eq(schema.conversation.orgId, orgId));
      await tx.delete(schema.contact).where(eq(schema.contact.orgId, orgId));
      await tx.delete(schema.customerActivity).where(eq(schema.customerActivity.orgId, orgId));
      await tx.delete(schema.customer).where(eq(schema.customer.orgId, orgId));
      await tx.delete(schema.mailbox).where(eq(schema.mailbox.orgId, orgId));
      await tx.delete(schema.rolePermission).where(eq(schema.rolePermission.orgId, orgId));
      await tx.delete(schema.aiEmployee).where(eq(schema.aiEmployee.orgId, orgId));
      await tx.delete(schema.userAccount).where(eq(schema.userAccount.orgId, orgId));
      await tx.delete(schema.org).where(eq(schema.org.id, orgId));
    });
  }
  await closeDb(db);
  await stopCheckpointer();
  redis.disconnect();
});

async function insertTask(
  orgId: string,
  employeeId: string,
  type: string,
  input: Record<string, unknown>,
): Promise<string> {
  const taskId = createId('task');
  await db.insert(schema.aiTask).values({
    id: taskId,
    orgId,
    employeeId,
    type: type as never,
    title: `M4 ${type}`,
    status: 'scheduled',
    input,
  });
  return taskId;
}

describe('M4-2 email_reply：语言跟随 + 审批闭环 + 类型化 outputs', () => {
  it('中文来信（language 缺失按正文检测）：grounded 分支由真实 LLM 判定，链路断言与 provider 输出无关', async () => {
    const taskId = await insertTask(ORG_ER, EMP_ER, 'email_reply', { inboxMessageId: MSG_ZH });

    // ① grounded 由真实 LLM 依据知识库判定：
    //    - true  → email_send（medium，无 autoApprove）→ 审批挂起 → 批准 resume → 真实外发
    //    - false → need_info 直接 completed（不发送）
    let result = await runner.run(taskId);
    let sent = false;
    if (result.status === 'waiting_approval') {
      sent = true;
      const [task1] = await db
        .select({ linkedApprovalId: schema.aiTask.linkedApprovalId })
        .from(schema.aiTask)
        .where(eq(schema.aiTask.id, taskId));
      const approvalId = task1.linkedApprovalId as string;
      expect(approvalId).toBeTruthy();
      // ② 批准 → resume：新鲜度校验通过 → 发送 → writeback → completed
      await db
        .update(schema.approvalRequest)
        .set({ status: 'approved', decidedAt: new Date() })
        .where(eq(schema.approvalRequest.id, approvalId));
      result = await runner.run(taskId, { resume: { nodeId: 'email_send', approvalId } });
    }
    expect(result.status).toBe('completed');

    // ③ 语言跟随（load_thread 确定性写回，与 LLM 输出无关）：language 缺失按正文检测为 zh
    const [inZh] = await db
      .select({ language: schema.message.language })
      .from(schema.message)
      .where(eq(schema.message.id, MSG_ZH));
    expect(inZh.language).toBe('zh');

    // ④ 类型化 outputs（14 §1.2）：draft + insight（两分支均产出）
    const outputs = result.outputs ?? [];
    expect(outputs.map((o) => o['type']).sort()).toEqual(['draft', 'insight'].sort());
    const draft = outputs.find((o) => o['type'] === 'draft')?.['payload'] as Record<
      string,
      unknown
    >;
    expect(draft['subject']).toBeTruthy();
    const insight = outputs.find((o) => o['type'] === 'insight')?.['payload'] as Record<
      string,
      unknown
    >;
    expect((insight['intent'] as Record<string, unknown>)['label']).toBeTruthy();
    expect(
      (insight['copilot'] as Record<string, unknown>)['purchaseProbability'],
    ).toBeGreaterThanOrEqual(0);

    // ⑤ LLM 记账：三节点齐（analyze_intent / copilot_analyze / draft_reply）
    const nodes = new Set(
      (
        await db
          .select({ node: schema.llmCall.node })
          .from(schema.llmCall)
          .where(eq(schema.llmCall.taskId, taskId))
      ).map((c) => c.node),
    );
    expect(nodes).toEqual(new Set(['analyze_intent', 'copilot_analyze', 'draft_reply']));

    // ⑥ M5-C4 洞察写回：conversation_insight 两分支均落（intent/概率/建议/citations）
    const [ci] = await db
      .select()
      .from(schema.conversationInsight)
      .where(eq(schema.conversationInsight.conversationId, CONV1));
    expect(ci).toBeTruthy();
    expect(ci.purchaseProbability).toBeGreaterThanOrEqual(0);
    expect(ci.purchaseProbability).toBeLessThanOrEqual(100);

    // ⑦ 走发送分支（grounded=true）时：外发 language=zh + writeback 落 CRM 活动
    if (sent) {
      const [outMsg] = await db
        .select({ language: schema.message.language, status: schema.message.status })
        .from(schema.message)
        .where(and(eq(schema.message.orgId, ORG_ER), eq(schema.message.direction, 'out')));
      expect(outMsg).toBeTruthy();
      expect(outMsg.language).toBe('zh');
      expect(outMsg.status).toBe('sent');
      const acts = await db
        .select({ id: schema.customerActivity.id, customerId: schema.customerActivity.customerId })
        .from(schema.customerActivity)
        .where(eq(schema.customerActivity.orgId, ORG_ER));
      expect(acts).toHaveLength(1);
      expect(acts[0]?.customerId).toBe(C1);
    }
  });
});

describe('M4-3 follow_up：autoApprove 留痕 / Break-up 强制人工 / 策略走完', () => {
  it('autoApprove + autoExecute 命中：直发留痕（auto_approved 单 + approval_log），不挂起', async () => {
    const taskId = await insertTask(ORG_FU, EMP_FU, 'follow_up', {
      followUpTaskId: FT1,
      customerId: CF1,
      conversationId: FU_CONV_OF.get(CF1) as string,
    });

    const result = await runner.run(taskId);
    expect(result.status).toBe('completed');

    // 直发留痕：approval_request(auto_approved) + approval_log（12 §7.1）
    const [auto] = await db
      .select({ status: schema.approvalRequest.status })
      .from(schema.approvalRequest)
      .where(
        and(eq(schema.approvalRequest.orgId, ORG_FU), eq(schema.approvalRequest.bizId, taskId)),
      );
    expect(auto.status).toBe('auto_approved');
    const logs = await db
      .select({ action: schema.approvalLog.action })
      .from(schema.approvalLog)
      .where(eq(schema.approvalLog.orgId, ORG_FU));
    expect(logs.some((l) => l.action === 'auto_approved')).toBe(true);

    // 外发 + 执行记录（sent，锚定第 1 步）
    const [outMsg] = await db
      .select({ status: schema.message.status })
      .from(schema.message)
      .where(and(eq(schema.message.orgId, ORG_FU), eq(schema.message.direction, 'out')));
    expect(outMsg.status).toBe('sent');
    const execs = await db
      .select({
        status: schema.followUpExecution.status,
        stepId: schema.followUpExecution.strategyStepId,
      })
      .from(schema.followUpExecution)
      .where(eq(schema.followUpExecution.followUpTaskId, FT1));
    expect(execs).toHaveLength(1);
    expect(execs[0]?.status).toBe('sent');
    expect(execs[0]?.stepId).toBe(SA_STEP_1);

    // 排期第 2 步：scheduled + nextRunAt 未来（dayOffset 3）
    const [ft] = await db
      .select({ status: schema.followUpTask.status, nextRunAt: schema.followUpTask.nextRunAt })
      .from(schema.followUpTask)
      .where(eq(schema.followUpTask.id, FT1));
    expect(ft.status).toBe('scheduled');
    expect((ft.nextRunAt as Date).getTime()).toBeGreaterThan(Date.now());
    const insight = result.outputs?.find((o) => o['type'] === 'insight')?.['payload'] as Record<
      string,
      unknown
    >;
    expect(insight['nextStep']).toMatchObject({ seq: 2 });
  });

  it('Break-up Email 强制人工：autoApprove 已开仍挂起，批准后才发送（例外优先于 autoApprove，07 §4）', async () => {
    const taskId = await insertTask(ORG_FU, EMP_FU, 'follow_up', {
      followUpTaskId: FT2,
      customerId: CF2,
      conversationId: FU_CONV_OF.get(CF2) as string,
    });

    // ① autoApprove 配置下仍强制人工
    const first = await runner.run(taskId);
    expect(first.status).toBe('waiting_approval');
    const [task1] = await db
      .select({ linkedApprovalId: schema.aiTask.linkedApprovalId })
      .from(schema.aiTask)
      .where(eq(schema.aiTask.id, taskId));
    const approvalId = task1.linkedApprovalId as string;
    const [req] = await db
      .select({ status: schema.approvalRequest.status })
      .from(schema.approvalRequest)
      .where(eq(schema.approvalRequest.id, approvalId));
    expect(req.status).toBe('pending');

    // ② 批准 → resume → 发送第 3 步（Break-up）
    await db
      .update(schema.approvalRequest)
      .set({ status: 'approved', decidedAt: new Date() })
      .where(eq(schema.approvalRequest.id, approvalId));
    const resumed = await runner.run(taskId, { resume: { nodeId: 'email_send', approvalId } });
    expect(resumed.status).toBe('completed');

    const execs = await db
      .select({
        status: schema.followUpExecution.status,
        stepId: schema.followUpExecution.strategyStepId,
      })
      .from(schema.followUpExecution)
      .where(eq(schema.followUpExecution.followUpTaskId, FT2));
    expect(execs).toHaveLength(3);
    expect(execs.filter((e) => e.status === 'sent')).toHaveLength(3);

    // 三步走完 → follow_up_task completed（schedule_next 无下一步）
    const [ft] = await db
      .select({ status: schema.followUpTask.status, nextRunAt: schema.followUpTask.nextRunAt })
      .from(schema.followUpTask)
      .where(eq(schema.followUpTask.id, FT2));
    expect(ft.status).toBe('completed');
    expect(ft.nextRunAt).toBeNull();
  });

  it('策略走完：末步执行后 follow_up_task=completed、nextRunAt 清空、outputs 无 nextStep', async () => {
    const taskId = await insertTask(ORG_FU, EMP_FU, 'follow_up', {
      followUpTaskId: FT3,
      customerId: CF3,
      conversationId: FU_CONV_OF.get(CF3) as string,
    });

    const result = await runner.run(taskId);
    expect(result.status).toBe('completed');

    // 第 2 步直发（autoApprove）→ 无第 3 步 → completed
    const [ft] = await db
      .select({ status: schema.followUpTask.status, nextRunAt: schema.followUpTask.nextRunAt })
      .from(schema.followUpTask)
      .where(eq(schema.followUpTask.id, FT3));
    expect(ft.status).toBe('completed');
    expect(ft.nextRunAt).toBeNull();

    const execs = await db
      .select({
        status: schema.followUpExecution.status,
        stepId: schema.followUpExecution.strategyStepId,
      })
      .from(schema.followUpExecution)
      .where(eq(schema.followUpExecution.followUpTaskId, FT3));
    expect(execs).toHaveLength(2);
    expect(execs.every((e) => e.status === 'sent')).toBe(true);

    // outputs：draft + insight（无 nextStep 字段）
    const insight = result.outputs?.find((o) => o['type'] === 'insight')?.['payload'] as Record<
      string,
      unknown
    >;
    expect(insight).toBeTruthy();
    expect(insight['nextStep']).toBeUndefined();
    expect(result.outputs?.some((o) => o['type'] === 'draft')).toBe(true);
  });
});
