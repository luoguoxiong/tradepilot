import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { Redis as IORedis, type Redis } from 'ioredis';
import pino from 'pino';
import {
  ApprovalGate,
  GraphCompiler,
  LlmGateway,
  TaskEventPublisher,
  TaskRunner,
  createCheckpointer,
} from '@tradepilot/runtime';
import { closeDb, createDb, schema, type Db } from '@tradepilot/db';
import { createId, encryptSecret } from '@tradepilot/core';
import {
  configureSearchProvider,
  createSmtpImapDriver,
  MockSearchProvider,
  type MailboxDriverRow,
} from '@tradepilot/integrations';
import { configureEmailSend, createToolRegistry } from '@tradepilot/tools';
import {
  createFlowRegistry,
  createOutputSchemaRegistry,
  createPromptRegistry,
  workflowSopProvider,
} from '@tradepilot/workflows';
import { EmailSyncProcessor } from '../src/queues/email-sync.js';

/**
 * M4 出口验收 · 三图 dry-run（后端开发计划表 M4-D 出口标准，C6 收口）：
 * 真实 SmtpImapDriver ↔ GreenMail 测试邮箱（SMTP 1025 / IMAP 1114）+ mock LLM + mock 搜索供应商。
 * - lead_hunting：parse_goal→web_search（mock 供应商确定性产出）→match_product→find_contact
 *   →save_to_crm_pool（ai_lead 落库）→finalize，LLM 记账（llm_call）全节点；
 * - email_reply：客户来信经真实 SMTP 投递 → EmailSyncProcessor 真实 IMAP 同步入库 + email_reply
 *   任务派发 → 图执行审批挂起 → 批准 resume → email_send 真实驱动外发 →
 *   IMAP 登录收件方邮箱验证回信到达（真实收发闭环）；
 * - follow_up：autoApprove 直发（auto_approved 留痕）→ 真实外发 → writeback_execution →
 *   schedule_next（频控顺延）→ 收件方邮箱验证第 1 步触达。
 * 前置：docker compose up（PG 5432 / Redis 6380 / GreenMail 1025+1114）+ `pnpm --filter @tradepilot/db migrate`。
 */

const SUPER_URL =
  process.env.TEST_SUPER_DATABASE_URL ??
  'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const SMTP_PORT = Number(process.env.MAILPIT_SMTP_PORT ?? 1025);
const IMAP_PORT = Number(process.env.MAILPIT_IMAP_PORT ?? 1114);
const KEY = '0'.repeat(64);
const GREENMAIL_PASS = 'greenmail';

const logger = pino({ level: process.env.TEST_LOG_LEVEL ?? 'silent' });

let db: Db;
let redis: Redis;
let runner: TaskRunner;
let processor: EmailSyncProcessor;
let stopCheckpointer: () => Promise<void>;

// ===== email_reply 租户（审批挂起语义）=====
const ORG_ER = createId('org');
const EMP_ER = createId('aie');
const C1 = createId('cus');
const CON1 = createId('con');
const CONV1 = createId('conv');
const MBX_ER = createId('mbx');
// GreenMail 收件地址即邮箱用户名：随机后缀避免历史数据串扰
const ACC_ER = `dryrun-er-${createId('mbx').slice(-8).toLowerCase()}@test.local`;
const BUYER_ER = `buyer-${ACC_ER.split('-')[2]}`;

// ===== follow_up 租户（autoApprove 直发语义）=====
const ORG_FU = createId('org');
const EMP_FU = createId('aie');
const SA = createId('fstr');
const SA_STEP_1 = createId('fstp');
const SA_STEP_2 = createId('fstp');
const CF = createId('cus');
const CONF = createId('con');
const CONV_F = createId('conv');
const FT = createId('ftask');
const MBX_FU = createId('mbx');
const ACC_FU = `dryrun-fu-${createId('mbx').slice(-8).toLowerCase()}@test.local`;
const BUYER_FU = `buyer-${ACC_FU.split('-')[2]}`;

// ===== lead_hunting 租户（mock 搜索供应商）=====
const ORG_LH = createId('org');
const EMP_LH = createId('aie');

function mailboxDriverRow(account: string, mailboxId: string, orgId: string): MailboxDriverRow {
  return {
    mailboxId,
    orgId,
    provider: 'smtp_imap',
    account,
    imap: {
      host: '127.0.0.1',
      port: IMAP_PORT,
      ssl: false,
      credential_enc: encryptSecret(GREENMAIL_PASS, KEY),
    },
    smtp: {
      host: '127.0.0.1',
      port: SMTP_PORT,
      ssl: false,
      credential_enc: encryptSecret(GREENMAIL_PASS, KEY),
    },
    syncScope: { historyDays: 90, folders: ['INBOX'] },
  };
}

beforeAll(async () => {
  db = createDb(SUPER_URL, { max: 5 });
  redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

  // ===== Runtime 装配（mock LLM + 默认工具/流/提示词/输出契约注册表）=====
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

  // ===== M4 真实链路注入：email_send 真实外发出口 + mock 搜索供应商（M4-B4 口径）=====
  configureEmailSend({ encryptionKey: KEY, db });
  configureSearchProvider(new MockSearchProvider());

  // q:email_sync 消费者（未注入 factory → 默认真实 SmtpImapDriver）
  processor = new EmailSyncProcessor({ db, redis, logger, driverOptions: { encryptionKey: KEY, db } });

  await db.transaction(async (tx) => {
    // ===== email_reply 租户 =====
    await tx.insert(schema.org).values({
      id: ORG_ER,
      name: 'M4 dry-run email_reply 租户',
      timezone: 'Asia/Shanghai',
      sendRules: { sendWindow: { start: '00:00', end: '24:00' }, minTouchIntervalDays: 0 },
    });
    await tx.insert(schema.userAccount).values({
      id: createId('usr'),
      orgId: ORG_ER,
      email: `dryrun-er-${ORG_ER.slice(-6)}@test.com`,
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
    await tx.insert(schema.mailbox).values({
      id: MBX_ER,
      orgId: ORG_ER,
      ownerUserId: null,
      provider: 'smtp_imap',
      account: ACC_ER,
      imap: mailboxDriverRow(ACC_ER, MBX_ER, ORG_ER).imap,
      smtp: mailboxDriverRow(ACC_ER, MBX_ER, ORG_ER).smtp,
      syncScope: { historyDays: 90, folders: ['INBOX'] },
      status: 'connected',
    });
    await tx.insert(schema.customer).values({
      id: C1,
      orgId: ORG_ER,
      companyName: 'DryRun Buyer Ltd',
      country: 'US',
      ownerId: (await tx.select({ id: schema.userAccount.id }).from(schema.userAccount).where(eq(schema.userAccount.orgId, ORG_ER)).limit(1))[0]!.id,
    });
    await tx.insert(schema.contact).values({
      id: CON1,
      orgId: ORG_ER,
      customerId: C1,
      name: 'James Buyer',
      title: 'Purchasing Manager',
      email: BUYER_ER,
      isPrimary: true,
    });
    await tx.insert(schema.conversation).values({
      id: CONV1,
      orgId: ORG_ER,
      customerId: C1,
      contactId: CON1,
      channel: 'email',
      mailboxId: MBX_ER,
    });

    // ===== follow_up 租户（autoApprove 全开）=====
    await tx.insert(schema.org).values({
      id: ORG_FU,
      name: 'M4 dry-run follow_up 租户',
      timezone: 'Asia/Shanghai',
      sendRules: { sendWindow: { start: '00:00', end: '24:00' }, minTouchIntervalDays: 0 },
    });
    const fuAdmin = createId('usr');
    await tx.insert(schema.userAccount).values({
      id: fuAdmin,
      orgId: ORG_FU,
      email: `dryrun-fu-${ORG_FU.slice(-6)}@test.com`,
      passwordHash: 'x',
      name: '测试管理员',
      role: 'admin',
      status: 'active',
    });
    await tx.insert(schema.rolePermission).values({
      id: createId('rp'),
      orgId: ORG_FU,
      role: 'sales',
      permissions: { customers: 'all', quotes: 'view', approvals: [], settings: 'none' },
      approvalRules: [{ approvalType: 'email_send', approverRoles: ['manager'], autoApprove: true }],
    });
    await tx.insert(schema.aiEmployee).values({
      id: EMP_FU,
      orgId: ORG_FU,
      role: 'sales',
      name: 'AI 跟进员',
      goal: '按策略跟进客户',
      tools: ['knowledge_search', 'email_send'],
      permissions: {},
      approvalPolicy: { email_send: 'high_value_only', quote: 'always', autoExecute: ['email_send'] },
      kpiConfig: [{ metric: 'touches', target: 5, period: 'daily' }],
    });
    await tx.insert(schema.mailbox).values({
      id: MBX_FU,
      orgId: ORG_FU,
      ownerUserId: fuAdmin,
      provider: 'smtp_imap',
      account: ACC_FU,
      imap: mailboxDriverRow(ACC_FU, MBX_FU, ORG_FU).imap,
      smtp: mailboxDriverRow(ACC_FU, MBX_FU, ORG_FU).smtp,
      syncScope: { historyDays: 90, folders: ['INBOX'] },
      status: 'connected',
    });
    await tx.insert(schema.followUpStrategy).values({
      id: SA,
      orgId: ORG_FU,
      name: 'dry-run 两步策略',
      targetScope: {},
      autoSendPolicy: 'auto_send',
      isDefault: false,
    });
    await tx.insert(schema.followUpStrategyStep).values([
      { id: SA_STEP_1, orgId: ORG_FU, strategyId: SA, seq: 1, dayOffset: 0, title: '首触' },
      { id: SA_STEP_2, orgId: ORG_FU, strategyId: SA, seq: 2, dayOffset: 3, title: '价值跟进' },
    ]);
    await tx.insert(schema.customer).values({
      id: CF,
      orgId: ORG_FU,
      companyName: 'DryRun Followup Ltd',
      country: 'DE',
      ownerId: fuAdmin,
    });
    await tx.insert(schema.contact).values({
      id: CONF,
      orgId: ORG_FU,
      customerId: CF,
      name: 'Hans Buyer',
      title: 'Buyer',
      email: BUYER_FU,
      isPrimary: true,
    });
    await tx.insert(schema.conversation).values({
      id: CONV_F,
      orgId: ORG_FU,
      customerId: CF,
      contactId: CONF,
      channel: 'email',
      mailboxId: MBX_FU,
    });
    await tx.insert(schema.followUpTask).values({
      id: FT,
      orgId: ORG_FU,
      customerId: CF,
      strategyId: SA,
      status: 'ready',
      nextRunAt: new Date(),
    });

    // ===== lead_hunting 租户 =====
    await tx.insert(schema.org).values({
      id: ORG_LH,
      name: 'M4 dry-run lead_hunting 租户',
      timezone: 'Asia/Shanghai',
    });
    await tx.insert(schema.userAccount).values({
      id: createId('usr'),
      orgId: ORG_LH,
      email: `dryrun-lh-${ORG_LH.slice(-6)}@test.com`,
      passwordHash: 'x',
      name: '测试管理员',
      role: 'admin',
      status: 'active',
    });
    await tx.insert(schema.aiEmployee).values({
      id: EMP_LH,
      orgId: ORG_LH,
      role: 'sales',
      name: 'AI 获客员',
      goal: '按目标搜寻潜在客户',
      tools: ['web_search', 'site_crawl', 'find_contact', 'lookup_contact', 'crm_write', 'knowledge_search'],
      permissions: {},
      approvalPolicy: { quote: 'always', autoExecute: [] },
      kpiConfig: [{ metric: 'leads', target: 5, period: 'daily' }],
    });
  });
}, 30_000);

afterAll(async () => {
  for (const orgId of [ORG_ER, ORG_FU, ORG_LH]) {
    await db.transaction(async (tx) => {
      await tx.delete(schema.aiLeadContact).where(eq(schema.aiLeadContact.orgId, orgId));
      await tx.delete(schema.aiLead).where(eq(schema.aiLead.orgId, orgId));
      await tx.delete(schema.aiDiscovery).where(eq(schema.aiDiscovery.orgId, orgId));
      await tx.delete(schema.llmCall).where(eq(schema.llmCall.orgId, orgId));
      await tx.delete(schema.aiTaskLog).where(eq(schema.aiTaskLog.orgId, orgId));
      await tx.delete(schema.aiTaskStep).where(eq(schema.aiTaskStep.orgId, orgId));
      await tx.delete(schema.aiTask).where(eq(schema.aiTask.orgId, orgId));
      await tx.delete(schema.approvalLog).where(eq(schema.approvalLog.orgId, orgId));
      await tx.delete(schema.approvalRequest).where(eq(schema.approvalRequest.orgId, orgId));
      await tx.delete(schema.followUpExecution).where(eq(schema.followUpExecution.orgId, orgId));
      await tx.delete(schema.followUpTask).where(eq(schema.followUpTask.orgId, orgId));
      await tx.delete(schema.followUpStrategyStep).where(eq(schema.followUpStrategyStep.orgId, orgId));
      await tx.delete(schema.followUpStrategy).where(eq(schema.followUpStrategy.orgId, orgId));
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
    title: `M4 dry-run ${type}`,
    status: 'scheduled',
    input,
  });
  return taskId;
}

/** IMAP 收件方视角：登录收件人邮箱拉取 INBOX（验证真实 SMTP 外发闭环） */
async function fetchInboxSubjects(account: string): Promise<{ subject: string; messageId: string }[]> {
  const driver = createSmtpImapDriver(
    {
      mailboxId: 'probe',
      orgId: 'probe',
      provider: 'smtp_imap',
      account,
      imap: {
        host: '127.0.0.1',
        port: IMAP_PORT,
        ssl: false,
        credential_enc: encryptSecret(GREENMAIL_PASS, KEY),
      },
      smtp: {
        host: '127.0.0.1',
        port: SMTP_PORT,
        ssl: false,
        credential_enc: encryptSecret(GREENMAIL_PASS, KEY),
      },
      syncScope: { historyDays: 30, folders: ['INBOX'] },
    },
    KEY,
  );
  const out: { subject: string; messageId: string }[] = [];
  for await (const raw of driver.syncMessages({
    since: new Date(Date.now() - 3600_000),
    folders: ['INBOX'],
  })) {
    out.push({ subject: raw.subject ?? '', messageId: raw.externalMessageId });
  }
  return out;
}

describe('M4 出口 dry-run · lead_hunting（mock 搜索供应商）', () => {
  it('图执行 completed：web_search→评分→联系人→crm_write 落 ai_lead，LLM 记账全节点', async () => {
    const taskId = await insertTask(ORG_LH, EMP_LH, 'lead_hunting', {
      goal: '寻找欧洲 LED 照明进口商',
      targetCount: 5,
    });

    const result = await runner.run(taskId);
    expect(result.status).toBe('completed');

    // save_to_crm_pool：ai_lead 落库（assemble_leads 汇总不带 domain，companyDomain 可空）
    const leads = await db
      .select({
        id: schema.aiLead.id,
        companyName: schema.aiLead.companyName,
        matchPct: schema.aiLead.matchPct,
        scoreLevel: schema.aiLead.scoreLevel,
        taskId: schema.aiLead.taskId,
      })
      .from(schema.aiLead)
      .where(eq(schema.aiLead.orgId, ORG_LH));
    expect(leads.length).toBeGreaterThanOrEqual(1);
    expect(leads.every((l) => l.companyName.length > 0)).toBe(true);
    expect(leads.every((l) => l.taskId === taskId)).toBe(true);
    expect(leads.every((l) => l.matchPct === 82 && l.scoreLevel === 'medium')).toBe(true);

    // LLM 记账（05 §6）：parse_goal / plan_search / match_product 三节点
    const nodes = (
      await db
        .select({ node: schema.llmCall.node })
        .from(schema.llmCall)
        .where(eq(schema.llmCall.taskId, taskId))
    ).map((c) => c.node);
    expect(new Set(nodes)).toEqual(new Set(['parse_goal', 'plan_search', 'match_product']));

    // 搜索/抓取/联系人工具日志留痕
    const steps = (
      await db
        .select({ name: schema.aiTaskStep.name })
        .from(schema.aiTaskStep)
        .where(eq(schema.aiTaskStep.taskId, taskId))
    ).map((s) => s.name);
    expect(steps).toContain('执行网页搜索');
    expect(steps).toContain('发现联系人');
    expect(steps).toContain('写入客户发现池');
  });
});

describe('M4 出口 dry-run · email_reply（真实 SMTP/IMAP 收发闭环）', () => {
  it('来信真实 IMAP 同步入库 → 派发 → 审批 → resume 真实 SMTP 外发 → 收件方 IMAP 收到', async () => {
    // ① 客户来信经真实驱动投递（GreenMail SMTP；收件人地址即邮箱用户名自动建箱）
    const inbound = createSmtpImapDriver(mailboxDriverRow(BUYER_ER, 'probe', 'probe'), KEY);
    const inboundResult = await inbound.sendMessage({
      from: BUYER_ER,
      to: [ACC_ER],
      subject: 'Inquiry for LED strips',
      text: 'Please send your latest catalog and best price for LED strips.',
    });
    expect(inboundResult.externalId).toBeTruthy();

    // ② EmailSyncProcessor 真实 IMAP 同步：入库 + email_reply 任务派发
    const outcome = await processor.process(MBX_ER);
    expect(outcome.status).toBe('synced');
    expect(outcome.fetched).toBe(1);
    expect(outcome.ingested).toBe(1);
    expect(outcome.replyTasksCreated).toBe(1);

    const [inMsg] = await db
      .select({ id: schema.message.id, conversationId: schema.message.conversationId })
      .from(schema.message)
      .where(
        and(
          eq(schema.message.orgId, ORG_ER),
          eq(schema.message.externalMessageId, inboundResult.externalId),
        ),
      );
    expect(inMsg).toBeTruthy();
    expect(inMsg!.conversationId).toBe(CONV1);

    const [task] = await db
      .select({ id: schema.aiTask.id })
      .from(schema.aiTask)
      .where(
        and(
          eq(schema.aiTask.orgId, ORG_ER),
          eq(schema.aiTask.type, 'email_reply'),
          sql`${schema.aiTask.input} ->> 'conversationId' = ${CONV1}`,
        ),
      )
      .limit(1);
    expect(task).toBeTruthy();

    // ③ 图执行：draft grounded=true → email_send（medium 无 autoApprove）→ 挂起
    const first = await runner.run(task!.id);
    expect(first.status).toBe('waiting_approval');
    const [task1] = await db
      .select({ linkedApprovalId: schema.aiTask.linkedApprovalId })
      .from(schema.aiTask)
      .where(eq(schema.aiTask.id, task!.id));
    const approvalId = task1.linkedApprovalId as string;
    expect(approvalId).toBeTruthy();

    // ④ 批准 → resume：新鲜度校验（真实重查会话）→ 真实 SMTP 外发 → writeback
    await db
      .update(schema.approvalRequest)
      .set({ status: 'approved', decidedAt: new Date() })
      .where(eq(schema.approvalRequest.id, approvalId));
    const resumed = await runner.run(task!.id, {
      resume: { nodeId: 'email_send', approvalId },
    });
    expect(resumed.status).toBe('completed');

    // ⑤ 外发落库：status=sent + 真实驱动 externalMessageId（非 mock- 前缀）
    const [outMsg] = await db
      .select({
        id: schema.message.id,
        status: schema.message.status,
        direction: schema.message.direction,
        externalMessageId: schema.message.externalMessageId,
        language: schema.message.language,
      })
      .from(schema.message)
      .where(and(eq(schema.message.orgId, ORG_ER), eq(schema.message.direction, 'out')));
    expect(outMsg).toBeTruthy();
    expect(outMsg!.status).toBe('sent');
    expect(outMsg!.externalMessageId).toBeTruthy();
    expect(outMsg!.externalMessageId!.startsWith('mock-')).toBe(false);

    // ⑥ 真实收发闭环：收件方 IMAP 登录收到回信（GreenMail SMTP 投递 → buyer 邮箱）
    const subjects = await fetchInboxSubjects(BUYER_ER);
    expect(subjects.length).toBeGreaterThanOrEqual(1);
    expect(subjects.some((s) => s.messageId === outMsg!.externalMessageId)).toBe(true);

    // ⑦ writeback：CRM 活动记录
    const acts = await db
      .select({ id: schema.customerActivity.id })
      .from(schema.customerActivity)
      .where(eq(schema.customerActivity.orgId, ORG_ER));
    expect(acts).toHaveLength(1);
  }, 30_000);
});

describe('M4 出口 dry-run · follow_up（autoApprove 直发 + 频控顺延）', () => {
  it('第 1 步直发（auto_approved 留痕）→ 真实外发到达 → schedule_next 排期第 2 步', async () => {
    const taskId = await insertTask(ORG_FU, EMP_FU, 'follow_up', {
      followUpTaskId: FT,
      customerId: CF,
      conversationId: CONV_F,
    });

    const result = await runner.run(taskId);
    expect(result.status).toBe('completed');

    // 直发留痕：approval_request(auto_approved) + approval_log（12 §7.1）
    const [auto] = await db
      .select({ status: schema.approvalRequest.status })
      .from(schema.approvalRequest)
      .where(and(eq(schema.approvalRequest.orgId, ORG_FU), eq(schema.approvalRequest.bizId, taskId)));
    expect(auto?.status).toBe('auto_approved');
    const logs = await db
      .select({ action: schema.approvalLog.action })
      .from(schema.approvalLog)
      .where(eq(schema.approvalLog.orgId, ORG_FU));
    expect(logs.some((l) => l.action === 'auto_approved')).toBe(true);

    // 外发落库（真实驱动）
    const [outMsg] = await db
      .select({
        status: schema.message.status,
        externalMessageId: schema.message.externalMessageId,
      })
      .from(schema.message)
      .where(and(eq(schema.message.orgId, ORG_FU), eq(schema.message.direction, 'out')));
    expect(outMsg?.status).toBe('sent');
    expect(outMsg?.externalMessageId!.startsWith('mock-')).toBe(false);

    // 执行记录（sent，锚定第 1 步）+ schedule_next：scheduled + nextRunAt 未来（dayOffset 3 窗口顺延）
    const [exec] = await db
      .select({ status: schema.followUpExecution.status, stepId: schema.followUpExecution.strategyStepId })
      .from(schema.followUpExecution)
      .where(eq(schema.followUpExecution.followUpTaskId, FT));
    expect(exec?.status).toBe('sent');
    expect(exec?.stepId).toBe(SA_STEP_1);
    const [ft] = await db
      .select({ status: schema.followUpTask.status, nextRunAt: schema.followUpTask.nextRunAt })
      .from(schema.followUpTask)
      .where(eq(schema.followUpTask.id, FT));
    expect(ft.status).toBe('scheduled');
    expect((ft.nextRunAt as Date).getTime()).toBeGreaterThan(Date.now());
    expect(result.outputs?.some((o) => o['type'] === 'draft')).toBe(true);

    // 真实收发闭环：收件方 IMAP 收到第 1 步触达
    const subjects = await fetchInboxSubjects(BUYER_FU);
    expect(subjects.length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
