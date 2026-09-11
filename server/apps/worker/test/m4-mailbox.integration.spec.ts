import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, sql } from 'drizzle-orm';
import { Redis as IORedis, type Redis } from 'ioredis';
import pino from 'pino';
import { decryptSecret } from '@tradepilot/core';
import { closeDb, createDb, schema, type Db } from '@tradepilot/db';
import { createId } from '@tradepilot/core';
import {
  createSmtpImapDriver,
  type MailboxDriverOptions,
  type RawMessage,
} from '@tradepilot/integrations';
import { configureEmailSend, emailSendTool, type ToolContext } from '@tradepilot/tools';
import type { EmailSyncProcessor } from '../src/queues/email-sync.js';
import { testMail, testMailboxRow } from './setup/providers.js';

/**
 * M4 #4/#5 邮箱集成专项用例（后端技术方案 06 §2.2/§2.3/§2.4）：
 * - 收信链路（q:email_sync 消费者）：幂等入库（Message-ID 冲突跳过）、conversation upsert
 *   （contact 匹配 / 未匹配新建轻量线索客户）、未读计数、自动 pause 进行中 follow_up_task
 *   + follow_up_execution(skipped, customer_replied)、email_reply 任务派发、last_synced_at 更新；
 * - 发信唯一出口：真实驱动外发 externalId 落库、最终失败 message.status='failed' + 50301、
 *   客户频控（minTouchIntervalDays）拦截 42901；
 * - 凭据信封加密往返（credential_enc → 驱动可见明文）。
 * 驱动契约：真实 SmtpImapDriver 对接本地 GreenMail（docker compose），无 mock 驱动。
 * 前置：docker compose up（PG 5432 / Redis 6380 / GreenMail 1025+1114）
 * + `pnpm --filter @tradepilot/db migrate`，且已提供 server/.env.test（真实 provider 配置）。
 */

const SUPER_URL =
  process.env.TEST_SUPER_DATABASE_URL ??
  'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';

const logger = pino({ level: process.env.TEST_LOG_LEVEL ?? 'silent' });

let db: Db;
let redis: Redis;
let processor: EmailSyncProcessor;

// ===== 租户与固定 ID =====
const ORG = createId('org');
const ADMIN = createId('usr');
const EMP = createId('emp');
const MBX = createId('mbx');
/** 不可达 SMTP 端点专用邮箱（发信失败路径，GREENMAIL 之外的坏端点） */
const MBX_BAD = createId('mbx');
const CUS1 = createId('cus');
const CON1 = createId('con');
const CONV1 = createId('conv');
const FT = createId('ftask');
const STRAT = createId('fstr');
// 频控租户
const ORG_PACE = createId('org');
const ADMIN_PACE = createId('usr');
const MBX_PACE = createId('mbx');
const CUS_PACE = createId('cus');
const CONV_PACE = createId('conv');

const CRED_KEY = '0'.repeat(64);

/** GreenMail：邮箱地址即账号（任意地址自动建箱、任意凭据可登录），按租户唯一避免串箱 */
const MBX_ACCOUNT = `sales-${ORG.slice(-6)}@tradepilot.local`;

/** 通过真实 SMTP 向被同步邮箱投递一封来信（GreenMail 收件，替代 mock 收件箱） */
async function deliverMail(params: {
  from: string;
  fromName?: string;
  subject: string;
  text: string;
}): Promise<void> {
  const sender = createSmtpImapDriver(
    testMailboxRow(params.from, createId('mbx'), ORG, CRED_KEY),
    CRED_KEY,
  );
  await sender.sendMessage({
    from: params.fromName ? `${params.fromName} <${params.from}>` : params.from,
    to: [MBX_ACCOUNT],
    subject: params.subject,
    text: params.text,
  });
}

beforeAll(async () => {
  db = createDb(SUPER_URL, { max: 5 });
  redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

  const { EmailSyncProcessor } = await import('../src/queues/email-sync.js');
  const driverOptions: MailboxDriverOptions = {
    encryptionKey: CRED_KEY,
    db,
  };
  configureEmailSend(driverOptions);
  processor = new EmailSyncProcessor({ db, redis, logger, driverOptions });

  await db.transaction(async (tx) => {
    // ===== 主租户：窗口全天开放 + 频控关闭 =====
    await tx.insert(schema.org).values({
      id: ORG,
      name: 'M4 邮箱集成租户',
      timezone: 'Asia/Shanghai',
      sendRules: { sendWindow: { start: '00:00', end: '24:00' }, minTouchIntervalDays: 0 },
    });
    await tx.insert(schema.userAccount).values({
      id: ADMIN,
      orgId: ORG,
      email: `mbx-${ORG.slice(-6)}@test.com`,
      passwordHash: 'x',
      name: '测试管理员',
      role: 'admin',
      status: 'active',
    });
    await tx.insert(schema.aiEmployee).values({
      id: EMP,
      orgId: ORG,
      role: 'sales',
      name: 'AI 销售员',
      goal: '回复客户邮件',
      tools: ['knowledge_search', 'email_send'],
      permissions: {},
      approvalPolicy: { email_send: 'always', quote: 'always', autoExecute: [] },
      kpiConfig: [{ metric: 'replies', target: 5, period: 'daily' }],
    });
    const liveRow = testMailboxRow(MBX_ACCOUNT, MBX, ORG, CRED_KEY);
    await tx.insert(schema.mailbox).values({
      id: MBX,
      orgId: ORG,
      ownerUserId: ADMIN,
      provider: 'smtp_imap',
      account: MBX_ACCOUNT,
      imap: liveRow.imap,
      smtp: liveRow.smtp,
      syncScope: { historyDays: 90, folders: ['INBOX', 'Sent'] },
      status: 'disconnected',
    });
    // 坏端点邮箱：SMTP 指向 1 端口（连接拒绝），用于发信失败路径
    const badRow = testMailboxRow(MBX_ACCOUNT, MBX_BAD, ORG, CRED_KEY);
    await tx.insert(schema.mailbox).values({
      id: MBX_BAD,
      orgId: ORG,
      ownerUserId: ADMIN,
      provider: 'smtp_imap',
      account: MBX_ACCOUNT,
      imap: badRow.imap,
      smtp: { ...badRow.smtp, port: 1 },
      syncScope: { historyDays: 90, folders: ['INBOX'] },
      status: 'connected',
    });
    // 既有客户 + 联系人 + 会话（contact 邮箱匹配路径）
    await tx.insert(schema.customer).values({
      id: CUS1,
      orgId: ORG,
      companyName: 'Acme Corp',
      country: 'US',
      ownerId: ADMIN,
    });
    await tx.insert(schema.contact).values({
      id: CON1,
      orgId: ORG,
      customerId: CUS1,
      name: 'James Buyer',
      title: 'Purchasing Manager',
      email: 'buyer@acme.com',
      isPrimary: true,
    });
    await tx.insert(schema.conversation).values({
      id: CONV1,
      orgId: ORG,
      customerId: CUS1,
      contactId: CON1,
      channel: 'email',
      mailboxId: MBX,
      unreadCount: 0,
    });
    // 进行中跟进任务 + 策略（新来信 → 自动 pause 语义）
    await tx.insert(schema.followUpStrategy).values({
      id: STRAT,
      orgId: ORG,
      name: '默认策略',
      targetScope: {},
      autoSendPolicy: 'auto_send',
    });
    await tx.insert(schema.followUpTask).values({
      id: FT,
      orgId: ORG,
      customerId: CUS1,
      strategyId: STRAT,
      status: 'scheduled',
      nextRunAt: new Date(Date.now() + 24 * 3600_000),
    });

    // ===== 频控租户：客户维度 minTouchIntervalDays=3 =====
    await tx.insert(schema.org).values({
      id: ORG_PACE,
      name: 'M4 频控租户',
      timezone: 'Asia/Shanghai',
      sendRules: { sendWindow: { start: '00:00', end: '24:00' }, minTouchIntervalDays: 3 },
    });
    await tx.insert(schema.userAccount).values({
      id: ADMIN_PACE,
      orgId: ORG_PACE,
      email: `pace-${ORG_PACE.slice(-6)}@test.com`,
      passwordHash: 'x',
      name: '频控管理员',
      role: 'admin',
      status: 'active',
    });
    const paceAccount = `pace-${ORG_PACE.slice(-6)}@tradepilot.local`;
    const paceRow = testMailboxRow(paceAccount, MBX_PACE, ORG_PACE, CRED_KEY);
    await tx.insert(schema.mailbox).values({
      id: MBX_PACE,
      orgId: ORG_PACE,
      ownerUserId: ADMIN_PACE,
      provider: 'smtp_imap',
      account: paceAccount,
      imap: paceRow.imap,
      smtp: paceRow.smtp,
      syncScope: { historyDays: 30, folders: ['INBOX'] },
      status: 'connected',
    });
    await tx.insert(schema.customer).values({
      id: CUS_PACE,
      orgId: ORG_PACE,
      companyName: 'Pace Buyer Ltd',
      country: 'DE',
      ownerId: ADMIN_PACE,
    });
    await tx.insert(schema.conversation).values({
      id: CONV_PACE,
      orgId: ORG_PACE,
      customerId: CUS_PACE,
      channel: 'email',
      mailboxId: MBX_PACE,
    });
    await tx.insert(schema.contact).values({
      id: createId('con'),
      orgId: ORG_PACE,
      customerId: CUS_PACE,
      name: 'Pace Contact',
      title: 'Buyer',
      email: 'contact@pace.com',
      isPrimary: true,
    });
    // 1 天前刚外发过一封 → 3 天频控内禁止再次外发
    await tx.insert(schema.message).values({
      id: createId('msg'),
      orgId: ORG_PACE,
      conversationId: CONV_PACE,
      direction: 'out',
      senderType: 'ai',
      senderName: 'AI 销售员工',
      mailboxId: MBX_PACE,
      content: '上一封外发',
      status: 'sent',
      sentAt: new Date(Date.now() - 24 * 3600_000),
    });
  });
});

afterAll(async () => {
  // 套件卫生：本用例的 scheduled 任务收尾取消，避免污染 Dispatcher 跨租户扫描（04 §3.3）
  await db
    .update(schema.aiTask)
    .set({ status: 'canceled' })
    .where(and(eq(schema.aiTask.orgId, ORG), eq(schema.aiTask.status, 'scheduled')));
  await db
    .update(schema.aiTask)
    .set({ status: 'canceled' })
    .where(and(eq(schema.aiTask.orgId, ORG_PACE), eq(schema.aiTask.status, 'scheduled')));
  await redis.quit();
  await closeDb(db);
});

// ===== 工具：构造 ToolContext（事务内执行 email_send；ai_task_log FK 要求 ai_task 行真实存在）=====
async function insertSendTask(orgId: string): Promise<string> {
  const taskId = createId('task');
  await db.insert(schema.aiTask).values({
    id: taskId,
    orgId,
    employeeId: EMP,
    type: 'email_reply',
    title: 'send test',
    status: 'scheduled',
    input: {},
  });
  return taskId;
}

function makeToolContext(
  orgId: string,
  taskId: string,
): {
  run: <T>(fn: (ctx: ToolContext) => Promise<T>) => Promise<T>;
} {
  const run = async <T>(fn: (ctx: ToolContext) => Promise<T>): Promise<T> =>
    db.transaction(async (tx) => {
      const ctx: ToolContext = {
        orgId,
        taskId,
        employeeId: EMP,
        nodeId: 'email_send',
        taskType: 'email_reply',
        tx,
        redis,
        logger,
        now: new Date(),
        bag: new Map(),
        log: async () => createId('tlog'),
        emit: () => undefined,
      };
      return fn(ctx);
    });
  return { run };
}

describe('M4 #4/#5 邮箱集成', () => {
  it('收信链路：contact 匹配入库 + 未匹配建档 + 幂等 + pause 跟进 + email_reply 派发', async () => {
    // 真实投递：GreenMail SMTP → 被同步邮箱 INBOX（无 mock 收件箱）
    await deliverMail({
      from: 'buyer@acme.com',
      fromName: 'James Buyer',
      subject: 'Re: 报价咨询',
      text: 'Please send your latest catalog and best price.',
    });
    await deliverMail({
      from: 'info@newco.com',
      fromName: 'New Co Ltd',
      subject: 'Product inquiry',
      text: 'We are looking for a supplier of LED lights.',
    });

    const outcome = await processor.process(MBX);
    expect(outcome.status).toBe('synced');
    expect(outcome.fetched).toBe(2);
    expect(outcome.ingested).toBe(2);
    expect(outcome.replyTasksCreated).toBe(2);

    // ---- msg1：既有 contact 匹配 ----
    const [msg1] = await db
      .select()
      .from(schema.message)
      .where(and(eq(schema.message.orgId, ORG), eq(schema.message.conversationId, CONV1)))
      .limit(1);
    expect(msg1).toBeTruthy();
    expect(msg1.direction).toBe('in');
    expect(msg1.conversationId).toBe(CONV1);
    expect(msg1.mailboxId).toBe(MBX);

    const [conv1] = await db
      .select()
      .from(schema.conversation)
      .where(eq(schema.conversation.id, CONV1))
      .limit(1);
    expect(conv1.unreadCount).toBe(1);
    expect(conv1.lastMessagePreview).toContain('catalog');

    // 自动 pause：跟进任务 paused + skipped(customer_replied) 留痕
    const [ft] = await db
      .select()
      .from(schema.followUpTask)
      .where(eq(schema.followUpTask.id, FT))
      .limit(1);
    expect(ft.status).toBe('paused');
    const [fexec] = await db
      .select()
      .from(schema.followUpExecution)
      .where(eq(schema.followUpExecution.followUpTaskId, FT))
      .orderBy(desc(schema.followUpExecution.createdAt))
      .limit(1);
    expect(fexec.status).toBe('skipped');
    expect(fexec.skipReason).toBe('customer_replied');

    // email_reply 任务派发（scheduled，input 指向会话与来信）
    const [task1] = await db
      .select()
      .from(schema.aiTask)
      .where(
        and(
          eq(schema.aiTask.orgId, ORG),
          eq(schema.aiTask.type, 'email_reply'),
          sql`${schema.aiTask.input} ->> 'conversationId' = ${CONV1}`,
        ),
      )
      .limit(1);
    expect(task1).toBeTruthy();
    expect(task1.status).toBe('scheduled');

    // ---- msg2：未匹配 → 轻量线索建档 ----
    const [newCustomer] = await db
      .select()
      .from(schema.customer)
      .where(and(eq(schema.customer.orgId, ORG), eq(schema.customer.companyName, 'New Co Ltd')))
      .limit(1);
    expect(newCustomer).toBeTruthy();
    expect(newCustomer.isFormal).toBe(false);
    const [newConv] = await db
      .select()
      .from(schema.conversation)
      .where(
        and(eq(schema.conversation.orgId, ORG), eq(schema.conversation.customerId, newCustomer.id)),
      )
      .limit(1);
    expect(newConv).toBeTruthy();
    expect(newConv.mailboxId).toBe(MBX);
    const [newMsg] = await db
      .select()
      .from(schema.message)
      .where(eq(schema.message.conversationId, newConv.id))
      .limit(1);
    expect(newMsg).toBeTruthy();
    expect(newMsg.direction).toBe('in');

    // ---- 出口：last_synced_at + status=connected ----
    const [mbx] = await db.select().from(schema.mailbox).where(eq(schema.mailbox.id, MBX)).limit(1);
    expect(mbx.status).toBe('connected');
    expect(mbx.lastSyncAt).toBeTruthy();

    // ---- 幂等：同一批消息再次同步 → 全部跳过 ----
    const second = await processor.process(MBX);
    expect(second.fetched).toBe(2);
    expect(second.ingested).toBe(0);
    const [conv1After] = await db
      .select()
      .from(schema.conversation)
      .where(eq(schema.conversation.id, CONV1))
      .limit(1);
    expect(conv1After.unreadCount).toBe(1);
  });

  it('凭据信封加密：密文落库、按主密钥可解出明文（08 §2）', async () => {
    const [mbxRow] = await db
      .select()
      .from(schema.mailbox)
      .where(eq(schema.mailbox.id, MBX))
      .limit(1);
    const cipher = mbxRow.imap?.credential_enc;
    expect(cipher).toBeDefined();
    expect(cipher).not.toBe(testMail.password);
    // 解密还原（真实驱动同步一开一合见上：驱动侧按同一主密钥解密后登录 GreenMail）
    expect(decryptSecret(cipher!, CRED_KEY)).toBe(testMail.password);
  });

  it('发信唯一出口：真实驱动发送成功，externalId 落库', async () => {
    const { run } = makeToolContext(ORG, await insertSendTask(ORG));
    const result = await run((ctx) =>
      emailSendTool.execute(ctx, {
        conversationId: CONV1,
        subject: 'Quotation for LED lights',
        body: 'Dear James, please find our quotation attached.',
      }),
    );
    expect(result.status).toBe('sent');
    expect(result.deduped).toBe(false);
    expect(result.externalMessageId).toBeTruthy();

    const [msg] = await db
      .select()
      .from(schema.message)
      .where(eq(schema.message.externalMessageId, result.externalMessageId))
      .limit(1);
    expect(msg.status).toBe('sent');
    expect(msg.direction).toBe('out');
    expect(msg.mailboxId).toBe(MBX);

    // 真实外发落点校验：GreenMail 收件箱（buyer@acme.com）可见该封邮件
    const recipient = createSmtpImapDriver(
      testMailboxRow('buyer@acme.com', createId('mbx'), ORG, CRED_KEY),
      CRED_KEY,
    );
    const received: RawMessage[] = [];
    for await (const mail of recipient.syncMessages({
      since: new Date(Date.now() - 3600_000),
      folders: ['INBOX'],
    })) {
      received.push(mail);
    }
    expect(received.some((m) => m.subject === 'Quotation for LED lights')).toBe(true);
  });

  it('发信失败：重试耗尽 → message.status=failed + 50301（06 §2.3）', async () => {
    // 真实不可达端点（MBX_BAD：SMTP 端口 1，连接拒绝）→ 重试耗尽映射 50301
    const { run } = makeToolContext(ORG, await insertSendTask(ORG));
    await expect(
      run((ctx) =>
        emailSendTool.execute(ctx, {
          conversationId: CONV1,
          mailboxId: MBX_BAD,
          subject: 'Will fail',
          body: 'This send should fail after retries.',
        }),
      ),
    ).rejects.toMatchObject({ code: 50301 });

    const [failed] = await db
      .select()
      .from(schema.message)
      .where(and(eq(schema.message.conversationId, CONV1), eq(schema.message.status, 'failed')))
      .limit(1);
    expect(failed).toBeTruthy();
    expect(failed.direction).toBe('out');
  });

  it('客户频控：minTouchIntervalDays 内禁止再次外发（42901）', async () => {
    const { run } = makeToolContext(ORG_PACE, await insertSendTask(ORG_PACE));
    await expect(
      run((ctx) =>
        emailSendTool.execute(ctx, {
          conversationId: CONV_PACE,
          subject: 'Should be blocked',
          body: 'Frequency capped.',
        }),
      ),
    ).rejects.toMatchObject({ code: 42901 });
  });
});
