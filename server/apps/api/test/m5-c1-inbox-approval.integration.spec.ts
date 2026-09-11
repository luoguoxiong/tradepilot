import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pino from 'pino';
import { BizException, createId } from '@tradepilot/core';
import { closeDb, createDb, schema, type Db } from '@tradepilot/db';
import { createSmtpImapDriver, type RawMessage } from '@tradepilot/integrations';
import { EnvService } from '../src/config/env.service.js';
import { testMailboxRow } from './setup/providers.js';
import { ApprovalsService } from '../src/approvals/approvals.service.js';
import { ConversationsService } from '../src/conversations/conversations.service.js';

/**
 * M5-C1 · 06（AI 销售工作台）↔ 12（AI 审核中心）联动集成用例：
 * - send 分支 B（审批策略）：message → waiting_approval + approval_request（bizType='message'），
 *   审批单字段契约对齐 12 §1.2/§1.3（title/context.contactName·subject·contentPreview/aiProposal.emailContent
 *   /confidence/reasons）；
 * - insert_draft：返回「合并后全文 + 草稿消息 id」，二次执行复用同一草稿（不产生重复草稿）；
 * - 12 §3.3 回调原业务动作：审核批准 → mailbox 真实外发（驱动被调用）+ message.status='sent'
 *   + resultRef={messageId,status:'sent'}；edited_approved → 以编辑稿外发 + editedDiff 留痕；
 *   拒绝 → message.status 回退 'draft' 可重编辑。
 * 前置：docker compose up（PG 5432 / Redis 6380 / GreenMail 1025+1114）
 * + `pnpm --filter @tradepilot/db migrate`，且已提供 server/.env.test（真实 provider 配置）。
 */

process.env.JWT_SECRET ||= 'it_only_test_secret_0123456789abcdef0123456789abcdef';
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.REDIS_URL ||= 'redis://localhost:6380';
process.env.DATABASE_URL ||= 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';

const SUPER_URL = 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';
const APP_URL = 'postgresql://tradepilot_app:changeme_app@localhost:5432/tradepilot';

const logger = pino({ level: process.env.TEST_LOG_LEVEL ?? 'silent' });

let superDb: Db;
let appDb: Db;
let redis: Redis;
let approvals: ApprovalsService;
let conversations: ConversationsService;

const ORG = createId('org');
const ADMIN = createId('usr');
const CUS = createId('cus');
const CONTACT = createId('con');
const MBX = createId('mbx');
/** GreenMail：邮箱地址即账号（按租户唯一避免串箱） */
const MBX_ACCOUNT = `m5c1-${ORG.slice(-6)}@tradepilot.local`;
const CONV = createId('conv');
const MSG_SEND = createId('msg');
const MSG_APPROVE = createId('msg');
const MSG_EDIT = createId('msg');
const MSG_REJECT = createId('msg');
const APR_APPROVE = createId('apr');
const APR_EDIT = createId('apr');
const APR_REJECT = createId('apr');

const ctx = { orgId: ORG, userId: ADMIN, role: 'admin' as const, scope: 'all' as const };

const ENC_KEY = process.env.ENCRYPTION_KEY!;

/** 读取某收件箱（GreenMail）指定 subject 的来信（真实外发落点校验） */
async function receivedMails(address: string, subject: string): Promise<RawMessage[]> {
  const driver = createSmtpImapDriver(
    testMailboxRow(address, createId('mbx'), ORG, ENC_KEY),
    ENC_KEY,
  );
  const mails: RawMessage[] = [];
  for await (const mail of driver.syncMessages({
    since: new Date(Date.now() - 3600_000),
    folders: ['INBOX'],
  })) {
    if (mail.subject === subject) mails.push(mail);
  }
  return mails;
}

async function expectBizError(p: Promise<unknown>, code: number): Promise<void> {
  try {
    await p;
    expect.fail(`应抛出错误码 ${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(BizException);
    expect((e as BizException).code).toBe(code);
  }
}

/** 造一条 waiting_approval 的起草消息 + 对应直接消息审批单（bizType='message'） */
async function seedMessageApproval(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  messageId: string,
  approvalId: string,
  content: string,
): Promise<void> {
  await tx.insert(schema.message).values({
    id: messageId,
    orgId: ORG,
    conversationId: CONV,
    direction: 'out',
    senderType: 'ai',
    senderName: 'AI 销售员',
    content,
    language: 'en',
    status: 'waiting_approval',
  });
  await tx.insert(schema.approvalRequest).values({
    id: approvalId,
    orgId: ORG,
    approvalType: 'email_send',
    riskLevel: 'medium',
    title: '邮件发送审核',
    bizType: 'message',
    bizId: messageId,
    context: {
      conversationId: CONV,
      customerId: CUS,
      contactName: 'Tom Buyer',
      subject: 'Re: Carbon insoles inquiry',
      contentPreview: content.slice(0, 120),
    },
    aiProposal: { emailContent: content },
    confidence: '0.900',
    reasons: [{ text: '命中审批规则：邮件发送需人工确认', source: 'approval_rule' }],
    requestedByUserId: ADMIN,
    expiresAt: new Date(Date.now() + 48 * 3600_000),
    status: 'pending',
    linkedTaskId: null,
  });
}

beforeAll(async () => {
  superDb = createDb(SUPER_URL, { max: 2 });
  appDb = createDb(APP_URL, { max: 5 });
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
  const env = new EnvService();
  approvals = new ApprovalsService(appDb, redis, logger, env);
  conversations = new ConversationsService(appDb, env, logger);

  await superDb.transaction(async (tx) => {
    await tx
      .insert(schema.org)
      .values({ id: ORG, name: 'M5-C1 联动租户', timezone: 'Asia/Shanghai' });
    await tx.insert(schema.userAccount).values({
      id: ADMIN,
      orgId: ORG,
      email: `m5c1-${ORG.slice(-6)}@test.com`,
      passwordHash: 'x',
      name: '联动管理员',
      role: 'admin',
      status: 'active',
    });
    await tx.insert(schema.customer).values({
      id: CUS,
      orgId: ORG,
      companyName: 'ABC Sports',
      country: 'US',
      ownerId: ADMIN,
    });
    await tx.insert(schema.contact).values({
      id: CONTACT,
      orgId: ORG,
      customerId: CUS,
      name: 'Tom Buyer',
      title: '采购经理',
      email: 'tom@abc-sports.com',
      isPrimary: true,
    });
    const mbx = testMailboxRow(MBX_ACCOUNT, MBX, ORG, ENC_KEY);
    await tx.insert(schema.mailbox).values({
      id: MBX,
      orgId: ORG,
      ownerUserId: ADMIN,
      provider: 'smtp_imap',
      account: MBX_ACCOUNT,
      imap: mbx.imap,
      smtp: mbx.smtp,
      syncScope: { historyDays: 90, folders: ['INBOX'] },
      status: 'connected',
    });
    await tx.insert(schema.conversation).values({
      id: CONV,
      orgId: ORG,
      customerId: CUS,
      contactId: CONTACT,
      channel: 'email',
      subject: 'Carbon insoles inquiry',
      priority: 'high',
      mailboxId: MBX,
      lastMessageAt: new Date(),
    });
    // send 分支 B 用草稿消息（无审批单，由 send 现场创建）
    await tx.insert(schema.message).values({
      id: MSG_SEND,
      orgId: ORG,
      conversationId: CONV,
      direction: 'out',
      senderType: 'ai',
      senderName: 'AI 销售员',
      content: 'Dear Tom,\n\nThank you for your inquiry.',
      language: 'en',
      status: 'draft',
    });
    await tx.insert(schema.conversationInsight).values({
      id: createId('cins'),
      orgId: ORG,
      conversationId: CONV,
      intent: 'rfq',
      purchaseProbability: 60,
      suggestions: [
        { suggestionId: 'sug-1', label: '强调 MOQ 500 双起订' },
        { suggestionId: 'sug-2', label: '附上 CE 认证说明' },
      ],
      generatedAt: new Date(),
    });
    await seedMessageApproval(tx, MSG_APPROVE, APR_APPROVE, '原稿正文 A');
    await seedMessageApproval(tx, MSG_EDIT, APR_EDIT, '原稿正文 B');
    await seedMessageApproval(tx, MSG_REJECT, APR_REJECT, '原稿正文 C');
  });
}, 30_000);

afterAll(async () => {
  await superDb.transaction(async (tx) => {
    await tx.delete(schema.approvalLog).where(eq(schema.approvalLog.orgId, ORG));
    await tx.delete(schema.approvalRequest).where(eq(schema.approvalRequest.orgId, ORG));
    await tx.delete(schema.message).where(eq(schema.message.orgId, ORG));
    await tx.delete(schema.conversationInsight).where(eq(schema.conversationInsight.orgId, ORG));
    await tx.delete(schema.conversation).where(eq(schema.conversation.orgId, ORG));
    await tx.delete(schema.contact).where(eq(schema.contact.orgId, ORG));
    await tx.delete(schema.customer).where(eq(schema.customer.orgId, ORG));
    await tx.delete(schema.mailbox).where(eq(schema.mailbox.orgId, ORG));
    await tx.delete(schema.userAccount).where(eq(schema.userAccount.orgId, ORG));
    await tx.delete(schema.org).where(eq(schema.org.id, ORG));
  });
  await redis.quit();
  await closeDb(appDb);
  await closeDb(superDb);
});

describe('M5-C1 · 06 #11 ↔ 12 #12 联动', () => {
  it('send 分支 B：waiting_approval + 审批单字段契约（12 §1.2/§1.3）', async () => {
    const resp = await conversations.send(ctx, CONV, { messageId: MSG_SEND });
    expect(resp.status).toBe('draft');
    const approvalId = resp.approval?.approvalId;
    expect(approvalId).toBeTruthy();

    const [apr] = await superDb
      .select()
      .from(schema.approvalRequest)
      .where(eq(schema.approvalRequest.id, approvalId!));
    expect(apr?.approvalType).toBe('email_send');
    expect(apr?.riskLevel).toBe('medium');
    expect(apr?.title).toBe('邮件发送审核');
    expect(apr?.bizType).toBe('message');
    expect(apr?.bizId).toBe(MSG_SEND);
    // 卡片差异化上下文：contactName / subject / contentPreview（前端 hasEmailContext 判定依赖）
    expect(apr?.context).toMatchObject({
      conversationId: CONV,
      customerId: CUS,
      contactName: 'Tom Buyer',
      subject: 'Carbon insoles inquiry',
    });
    expect(String(apr?.context?.['contentPreview']).length).toBeGreaterThan(0);
    expect(apr?.aiProposal).toMatchObject({
      emailContent: 'Dear Tom,\n\nThank you for your inquiry.',
    });
    expect(apr?.confidence).not.toBeNull();
    expect(apr?.reasons?.length ?? 0).toBeGreaterThanOrEqual(1);

    const [msg] = await superDb
      .select({ status: schema.message.status })
      .from(schema.message)
      .where(eq(schema.message.id, MSG_SEND));
    expect(msg?.status).toBe('waiting_approval');
  });

  it('insert_draft：返回合并后全文 + 草稿消息 id，二次执行复用同一草稿', async () => {
    const first = await conversations.applySuggestions(ctx, {
      conversationId: CONV,
      suggestionIds: ['sug-1'],
      mode: 'insert_draft',
    });
    expect(first.draftId).toBeTruthy();
    expect(first.draftContent).toContain('强调 MOQ 500 双起订');

    const second = await conversations.applySuggestions(ctx, {
      conversationId: CONV,
      suggestionIds: ['sug-2'],
      mode: 'insert_draft',
    });
    expect(second.draftId).toBe(first.draftId);
    expect(second.draftContent).toContain('强调 MOQ 500 双起订');
    expect(second.draftContent).toContain('附上 CE 认证说明');

    // 草稿消息真实落库（后续 PUT 编辑 / send 可命中）
    const [draft] = await superDb
      .select({ status: schema.message.status, content: schema.message.content })
      .from(schema.message)
      .where(eq(schema.message.id, first.draftId!));
    expect(draft?.status).toBe('draft');
    expect(draft?.content).toBe(second.draftContent);
  });

  it('approve：回调原业务动作 —— mailbox 真实外发 + message=sent + resultRef', async () => {
    const result = await approvals.approve(ORG, ADMIN, APR_APPROVE, { action: 'approve' });
    expect(result.status).toBe('approved');
    expect(result.resultRef).toEqual({ messageId: MSG_APPROVE, status: 'sent' });

    const [msg] = await superDb
      .select({
        status: schema.message.status,
        content: schema.message.content,
        externalMessageId: schema.message.externalMessageId,
        sentAt: schema.message.sentAt,
      })
      .from(schema.message)
      .where(eq(schema.message.id, MSG_APPROVE));
    expect(msg?.status).toBe('sent');
    expect(msg?.content).toBe('原稿正文 A');
    expect(msg?.externalMessageId).toBeTruthy();
    expect(msg?.sentAt).toBeTruthy();

    // 真实外发落点：收件人（GreenMail tom@abc-sports.com）INBOX 可见该封邮件，
    // 主题来自审批 context，正文为原稿
    const mails = await receivedMails('tom@abc-sports.com', 'Re: Carbon insoles inquiry');
    expect(mails.length).toBeGreaterThanOrEqual(1);
    expect(mails.at(-1)?.text ?? '').toContain('原稿正文 A');

    // 会话摘要回写
    const [conv] = await superDb
      .select({ preview: schema.conversation.lastMessagePreview })
      .from(schema.conversation)
      .where(eq(schema.conversation.id, CONV));
    expect(conv?.preview).toBe('原稿正文 A');
  });

  it('edited_approved：以编辑稿外发 + editedDiff 留痕（aiProposal.emailContent）', async () => {
    const result = await approvals.approve(ORG, ADMIN, APR_EDIT, {
      action: 'edited_approved',
      editedContent: { aiProposal: { emailContent: '编辑后正文 B' } },
    });
    expect(result.status).toBe('edited_approved');

    const [msg] = await superDb
      .select({ status: schema.message.status, content: schema.message.content })
      .from(schema.message)
      .where(eq(schema.message.id, MSG_EDIT));
    expect(msg?.status).toBe('sent');
    expect(msg?.content).toBe('编辑后正文 B');
    // 真实外发落点：以编辑稿正文投递
    const mails = await receivedMails('tom@abc-sports.com', 'Re: Carbon insoles inquiry');
    expect(mails.at(-1)?.text ?? '').toContain('编辑后正文 B');

    const logs = await approvals.logs(ORG, APR_EDIT);
    expect(logs[0]?.action).toBe('edited_approved');
    expect(logs[0]?.editedDiff).toEqual([
      { field: 'aiProposal.emailContent', before: '原稿正文 B', after: '编辑后正文 B' },
    ]);
  });

  it('reject：message 回退 draft（可重编辑重发）+ rejectReason 留痕', async () => {
    const result = await approvals.reject(ORG, ADMIN, APR_REJECT, { reason: '内容不合适，需重写' });
    expect(result.status).toBe('rejected');

    const [msg] = await superDb
      .select({ status: schema.message.status })
      .from(schema.message)
      .where(eq(schema.message.id, MSG_REJECT));
    expect(msg?.status).toBe('draft');

    const logs = await approvals.logs(ORG, APR_REJECT);
    expect(logs[0]?.action).toBe('rejected');
    expect(logs[0]?.rejectReason).toBe('内容不合适，需重写');

    // 已处置 → 再次处置 40901
    await expectBizError(approvals.approve(ORG, ADMIN, APR_REJECT, { action: 'approve' }), 40901);
  });

  it('list：status=processed 返回已处置历史（12 §3.2）', async () => {
    const processed = await approvals.list(ORG, { status: 'processed', page: 1, pageSize: 20 });
    expect(processed.total).toBe(3);
    const ids = processed.items.map((i) => i['approvalId']);
    expect(ids).toEqual(expect.arrayContaining([APR_APPROVE, APR_EDIT, APR_REJECT]));

    const approved = processed.items.find((i) => i['approvalId'] === APR_APPROVE) as Record<
      string,
      unknown
    >;
    expect(approved['status']).toBe('approved');
    expect(approved['approverName']).toBe('联动管理员');

    const rejected = processed.items.find((i) => i['approvalId'] === APR_REJECT) as Record<
      string,
      unknown
    >;
    expect(rejected['rejectReason']).toBe('内容不合适，需重写');
  });

  it('summary：email_send / customer_delete 为常驻 Tab（count=0 也返回）', async () => {
    const { tabs } = await approvals.summary(ORG);
    // 仅剩 send 分支 B 产生的 1 条 pending（其余已在上面处置）
    expect(tabs.find((t) => t.type === 'all')?.count).toBe(1);
    expect(tabs.find((t) => t.type === 'email_send')?.count).toBe(1);
    // customer_delete 无待审仍保留 Tab 入口（前端 Tab 只渲染服务端返回类型）
    expect(tabs.some((t) => t.type === 'customer_delete' && t.count === 0)).toBe(true);
  });
});
