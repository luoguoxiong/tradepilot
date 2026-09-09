import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { BizException, createId, ErrorCode } from '@tradepilot/core';
import { closeDb, createDb, schema, type Db, type OrgScopeContext } from '@tradepilot/db';
import type { MailboxDriverOptions } from '@tradepilot/integrations';
import {
  isModuleEnabled,
  listEnabledModules,
  MODULE_KEY,
  NOTIFY_EVENT_KEY,
} from '@tradepilot/shared';
import { EnvService } from '../src/config/env.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { TokenService } from '../src/auth/token.service.js';
import { CustomersService } from '../src/customers/customers.service.js';
import { createCustomerSchema } from '../src/customers/customers.dto.js';
import { ConversationsService } from '../src/conversations/conversations.service.js';
import { NotifyProcessor } from '../../worker/src/queues/notify.js';

/**
 * M5 批次 A 集成测试（后端开发计划表 M5）：
 * - A1 模块启用判定器：P0 基线全部 P1 模块禁用（D1~D12 降级矩阵收口）；
 * - A2 通知分发：q:notify 消费端按 notification_setting 事件×渠道矩阵分发，
 *   site 落库 / 双关跳过 / email 无邮箱降级；
 * - A3 会话读侧：列表 scope 裁剪 + keyword、detail 读即清未读、copilot 洞察/空态兜底；
 * - A4 客户基座：创建（同名去重）、列表 tab/keyword、编辑转交（角色越权 40301）、
 *   stage 阶段机（正向 OK / 非法回退 40901 / 活动留痕）。
 * 前置：docker compose up（PG 5432 / Redis 6380）+ 迁移已执行。
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

let orgId = '';
let adminId = '';
let salesId = '';
let adminCtx: OrgScopeContext;
let salesCtx: OrgScopeContext;
let customers: CustomersService;
let conversations: ConversationsService;
let notify: NotifyProcessor;

const adminEmail = `it-m5a-${createId('org')}@test.com`;
const salesEmail = `it-m5a-sales-${createId('org')}@test.com`;

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

beforeAll(async () => {
  superDb = createDb(SUPER_URL, { max: 2 });
  appDb = createDb(APP_URL, { max: 5 });
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
  const env = new EnvService();
  const tokens = new TokenService(env, redis);
  const auth = new AuthService(appDb, tokens, redis);

  const session = await auth.register({
    companyName: 'IT M5 批次A租户',
    contactName: '管理员',
    email: adminEmail,
    password: 'password123',
  });
  orgId = session.user.orgId;
  adminId = session.user.userId;

  // sales 成员 fixture（不经邀请链路；仅做角色/数据范围断言）
  salesId = createId('usr');
  await superDb.insert(schema.userAccount).values({
    id: salesId,
    orgId,
    email: salesEmail,
    passwordHash: 'fixture_no_login',
    name: '销售甲',
    role: 'sales',
    status: 'active',
  });

  adminCtx = { orgId, userId: adminId, role: 'admin', scope: 'all' };
  salesCtx = { orgId, userId: salesId, role: 'sales', scope: 'self' };

  customers = new CustomersService(appDb);
  conversations = new ConversationsService(appDb);
  notify = new NotifyProcessor({
    db: appDb,
    logger: pino({ level: 'silent' }),
    driverOptions: {} as MailboxDriverOptions,
  });
}, 30_000);

afterAll(async () => {
  if (orgId) {
    await superDb.transaction(async (tx) => {
      await tx.delete(schema.notification).where(eq(schema.notification.orgId, orgId));
      await tx.delete(schema.notificationSetting).where(eq(schema.notificationSetting.orgId, orgId));
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
      await tx.delete(schema.conversationInsight).where(eq(schema.conversationInsight.orgId, orgId));
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
  await redis.quit();
  await closeDb(appDb);
  await closeDb(superDb);
});

// ============================== A1 模块启用判定器 ==============================

describe('M5-A1 · 模块启用判定器（00 §5.1 D1~D12 收口）', () => {
  it('P0 基线：全部 P1 模块禁用，聚合接口按「隐藏」降级', () => {
    for (const key of Object.values(MODULE_KEY)) {
      expect(isModuleEnabled(key)).toBe(false);
    }
    expect(listEnabledModules()).toEqual([]);
  });

  it('判定器为唯一事实源：quote/order/product/ai_manager/task_ops/data_center 六键全覆盖', () => {
    expect(Object.keys(MODULE_KEY).length).toBe(6);
  });
});

// ============================== A2 通知分发 ==============================

describe('M5-A2 · q:notify 消费端按设置矩阵分发', () => {
  beforeAll(async () => {
    await superDb.insert(schema.notificationSetting).values({
      id: createId('nset'),
      orgId,
      channels: { site: true, email: true },
      events: {
        [NOTIFY_EVENT_KEY.APPROVAL_PENDING]: { site: true, email: false },
        [NOTIFY_EVENT_KEY.RISK_ALERT]: { site: false, email: false },
        [NOTIFY_EVENT_KEY.TASK_FAILED]: { site: true, email: true },
      },
    });
  });

  it('site 开 / email 关：站内落库 + email skipped + email_sent_at 空', async () => {
    const out = await notify.process({
      type: 'approval_pending',
      orgId,
      title: '新报价待审核',
      content: '客户 A 的报价单等待审批',
      refType: 'approval',
      refId: 'appr_fixture',
    });
    expect(out).toMatchObject({
      orgId,
      event: NOTIFY_EVENT_KEY.APPROVAL_PENDING,
      site: true,
      email: 'skipped',
    });

    const [row] = await superDb
      .select()
      .from(schema.notification)
      .where(and(eq(schema.notification.orgId, orgId), eq(schema.notification.event, 'approval_pending')))
      .limit(1);
    expect(row).toBeDefined();
    expect(row!.title).toBe('新报价待审核');
    expect(row!.refId).toBe('appr_fixture');
    expect(row!.emailSentAt).toBeNull();
  });

  it('事件键映射：approval_expired → approval_pending（超时提醒同键，12 §7）', async () => {
    const out = await notify.process({
      type: 'approval_expired',
      orgId,
      title: '审批已超时',
    });
    expect(out.event).toBe(NOTIFY_EVENT_KEY.APPROVAL_PENDING);
  });

  it('双渠道全关：不落库不外发（消费即 ack）', async () => {
    const before = await superDb
      .select({ id: schema.notification.id })
      .from(schema.notification)
      .where(eq(schema.notification.orgId, orgId));
    const out = await notify.process({
      type: 'budget_limit',
      orgId,
      title: '预算超限风险',
    });
    expect(out.event).toBe(NOTIFY_EVENT_KEY.RISK_ALERT);
    expect(out.site).toBe(false);
    expect(out.email).toBe('skipped');
    const after = await superDb
      .select({ id: schema.notification.id })
      .from(schema.notification)
      .where(eq(schema.notification.orgId, orgId));
    expect(after.length).toBe(before.length);
  });

  it('email 开但无 connected 邮箱：降级仅站内（06 §2.3 边界）', async () => {
    const out = await notify.process({
      type: 'task_failed',
      orgId,
      title: 'AI 任务失败',
    });
    expect(out).toMatchObject({ site: true, email: 'no_mailbox' });
  });
});

// ============================== A4 客户基座 ==============================

describe('M5-A4 · 05 CRM 客户中心（列表/创建/编辑/stage）', () => {
  let cusA = '';
  let cusB = '';

  it('创建：admin 归己 + 默认 new_lead + contacts 级联', async () => {
    const resp = await customers.create(
      adminCtx,
      createCustomerSchema.parse({
        companyName: 'M5A 汉堡进出口 GmbH',
        country: 'Germany',
        customerType: 'brand',
        contacts: [{ name: 'Hans', title: '采购经理', email: `hans-${createId('cont')}@example.com` }],
      }),
    );
    cusA = resp.customerId;
    expect(resp.ownerId).toBe(adminId);
    expect(resp.stage).toBe('new_lead');

    const [contactRow] = await superDb
      .select()
      .from(schema.contact)
      .where(eq(schema.contact.customerId, cusA));
    expect(contactRow?.name).toBe('Hans');
  });

  it('同名去重（大小写不敏感）→ 40901', async () => {
    await expectBiz(
      customers.create(adminCtx, {
        companyName: 'm5a 汉堡进出口 gmbh',
        country: 'Germany',
      }),
      ErrorCode.CONFLICT,
    );
  });

  it('创建正式客户（isFormal）→ tab=formal 命中，potential 排除', async () => {
    const resp = await customers.create(adminCtx, {
      companyName: 'M5A 里昂贸易 SARL',
      country: 'France',
      isFormal: true,
    });
    cusB = resp.customerId;

    const potential = await customers.list(adminCtx, { page: 1, pageSize: 20, tab: 'potential' });
    const formal = await customers.list(adminCtx, { page: 1, pageSize: 20, tab: 'formal' });
    expect(potential.items.map((i) => i.customerId)).toContain(cusA);
    expect(potential.items.map((i) => i.customerId)).not.toContain(cusB);
    expect(formal.items.map((i) => i.customerId)).toContain(cusB);
    expect(formal.items.map((i) => i.customerId)).not.toContain(cusA);
  });

  it('keyword 命中公司名', async () => {
    const resp = await customers.list(adminCtx, { page: 1, pageSize: 20, keyword: '里昂' });
    expect(resp.items.map((i) => i.customerId)).toEqual([cusB]);
    expect(resp.total).toBe(1);
  });

  it('sales 创建归己；scope=self 列表只见自己的客户', async () => {
    const resp = await customers.create(salesCtx, {
      companyName: 'M5A 大阪商事株式会社',
      country: 'Japan',
    });
    const mine = await customers.list(salesCtx, { page: 1, pageSize: 20 });
    expect(mine.items.map((i) => i.customerId)).toEqual([resp.customerId]);
    expect(mine.items.every((i) => i.ownerId === salesId)).toBe(true);

    const all = await customers.list(adminCtx, { page: 1, pageSize: 50 });
    expect(all.total).toBe(3);
  });

  it('sales 转交他人 → 40301（负责人指派仅 manager/admin）', async () => {
    const mine = await customers.list(salesCtx, { page: 1, pageSize: 20 });
    const myCustomer = mine.items[0]!;
    await expectBiz(
      customers.update(salesCtx, myCustomer.customerId, { ownerId: adminId }),
      ErrorCode.FORBIDDEN,
    );
  });

  it('admin 转交 → owner_change 活动留痕 + 数据范围即时切换', async () => {
    const resp = await customers.update(adminCtx, cusA, { ownerId: salesId });
    expect(resp.ownerId).toBe(salesId);

    const [act] = await superDb
      .select()
      .from(schema.customerActivity)
      .where(
        and(
          eq(schema.customerActivity.orgId, orgId),
          eq(schema.customerActivity.type, 'owner_change'),
          eq(schema.customerActivity.customerId, cusA),
        ),
      );
    expect(act?.summary).toContain('负责人变更');
    expect(act?.operatorId).toBe(adminId);

    // 切换后 sales(self) 能看到 cusA，admin(all) 全量不受影响
    const salesView = await customers.list(salesCtx, { page: 1, pageSize: 50 });
    expect(salesView.items.map((i) => i.customerId)).toContain(cusA);
  });

  it('同名改名冲突 → 40901；正常改名生效', async () => {
    await expectBiz(
      customers.update(adminCtx, cusA, { companyName: 'M5A 里昂贸易 SARL' }),
      ErrorCode.CONFLICT,
    );
    await customers.update(adminCtx, cusA, { website: 'https://example.com' });
  });

  it('stage 正向流转（含跳级）→ stage_change 活动', async () => {
    const resp = await customers.stage(adminCtx, cusA, { stage: 'negotiation' });
    expect(resp.stage).toBe('negotiation');
    const [act] = await superDb
      .select()
      .from(schema.customerActivity)
      .where(
        and(
          eq(schema.customerActivity.orgId, orgId),
          eq(schema.customerActivity.type, 'stage_change'),
          eq(schema.customerActivity.customerId, cusA),
        ),
      );
    expect(act?.summary).toContain('new_lead → negotiation');
  });

  it('stage 非法流转：跳变同阶段 / 非 contacted 回退 → 40901', async () => {
    await expectBiz(customers.stage(adminCtx, cusA, { stage: 'negotiation' }), ErrorCode.CONFLICT);
    await expectBiz(customers.stage(adminCtx, cusA, { stage: 'new_lead' }), ErrorCode.CONFLICT);
  });

  it('stage 回退 contacted 允许（05 §3.2 唯一合法回退）', async () => {
    const resp = await customers.stage(adminCtx, cusA, { stage: 'contacted', reason: '客户重新激活' });
    expect(resp.stage).toBe('contacted');
  });

  it('sales 访问他人客户（scope=self）→ 40301 防旁路', async () => {
    await expectBiz(customers.update(salesCtx, cusB, { remark: '越权' }), ErrorCode.FORBIDDEN);
  });
});

// ============================== A3 会话读侧 ==============================

describe('M5-A3 · 06 会话读侧（列表/详情/copilot）', () => {
  let convId = '';
  let convNoInsightId = '';

  beforeAll(async () => {
    const customerId = createId('cus');
    await superDb.insert(schema.customer).values({
      id: customerId,
      orgId,
      companyName: 'M5A 会话客户 Ltd',
      country: 'UK',
      stage: 'negotiation',
      ownerId: adminId,
    });
    const contactId = createId('cont');
    await superDb.insert(schema.contact).values({
      id: contactId,
      orgId,
      customerId,
      name: 'Emma',
      title: 'Buyer',
      email: `emma-${createId('cont')}@example.com`,
    });

    convId = createId('conv');
    await superDb.insert(schema.conversation).values({
      id: convId,
      orgId,
      customerId,
      contactId,
      subject: 'Re: RFQ brackets',
      priority: 'high',
      unreadCount: 3,
      lastMessageAt: new Date(),
      lastMessagePreview: 'Please quote 5000pcs',
    });
    await superDb.insert(schema.message).values([
      {
        id: createId('msg'),
        orgId,
        conversationId: convId,
        direction: 'in',
        senderType: 'contact',
        senderName: 'Emma',
        content: 'We need 5000pcs of brackets.',
        status: 'sent',
        sentAt: new Date(Date.now() - 3_600_000),
      },
      {
        id: createId('msg'),
        orgId,
        conversationId: convId,
        direction: 'out',
        senderType: 'ai',
        senderName: '跟进员工',
        content: 'Draft reply with quotation.',
        status: 'draft',
      },
    ]);
    await superDb.insert(schema.conversationInsight).values({
      id: createId('ins'),
      orgId,
      conversationId: convId,
      intent: 'rfq',
      purchaseProbability: 70,
      suggestions: [{ suggestionId: 'sug_1', label: '发送报价单' }],
      citations: [{ docId: 'doc_1', docName: '价格表', chunkId: 'chk_1' }],
      generatedAt: new Date(),
    });

    // 无洞察会话（空态兜底口径）
    convNoInsightId = createId('conv');
    await superDb.insert(schema.conversation).values({
      id: convNoInsightId,
      orgId,
      customerId,
      subject: 'Greetings',
      priority: 'normal',
      unreadCount: 0,
      lastMessageAt: new Date(Date.now() - 86_400_000),
      lastMessagePreview: 'Hello',
    });
  });

  it('列表：字段聚合（contactName 回落/公司名）+ keyword 命中', async () => {
    const resp = await conversations.list(adminCtx, {
      page: 1,
      pageSize: 20,
      keyword: '会话客户',
    });
    const target = resp.items.find((i) => i.conversationId === convId);
    expect(target).toBeDefined();
    expect(target!.contactName).toBe('Emma');
    expect(target!.companyName).toBe('M5A 会话客户 Ltd');
    expect(target!.priority).toBe('high');
    expect(target!.unreadCount).toBe(3);
    expect(target!.lastMessagePreview).toBe('Please quote 5000pcs');
  });

  it('列表：unreadOnly / priority 筛选 + scope=self 他人客户会话不可见', async () => {
    const unread = await conversations.list(adminCtx, { page: 1, pageSize: 20, unreadOnly: true });
    expect(unread.items.map((i) => i.conversationId)).toContain(convId);
    expect(unread.items.map((i) => i.conversationId)).not.toContain(convNoInsightId);

    const high = await conversations.list(adminCtx, { page: 1, pageSize: 20, priority: 'high' });
    expect(high.items.every((i) => i.priority === 'high')).toBe(true);

    // sales(self)：客户 owner=admin → 不可见
    const salesView = await conversations.list(salesCtx, { page: 1, pageSize: 50 });
    expect(salesView.total).toBe(0);
  });

  it('详情：消息时间线（in/out 排序）+ 读即清未读（FR-02）', async () => {
    const detail = await conversations.detail(adminCtx, convId);
    expect(detail.conversationId).toBe(convId);
    expect(detail.stage).toBe('negotiation');
    expect(detail.messages.map((m) => m.direction)).toEqual(['in', 'out']);
    expect(detail.messages[0]!.senderName).toBe('Emma');

    const [row] = await superDb
      .select({ unreadCount: schema.conversation.unreadCount })
      .from(schema.conversation)
      .where(eq(schema.conversation.id, convId));
    expect(row!.unreadCount).toBe(0);
  });

  it('详情：sales(self) 越权 40301；不存在 40401', async () => {
    await expectBiz(conversations.detail(salesCtx, convId), ErrorCode.FORBIDDEN);
    await expectBiz(conversations.detail(adminCtx, 'conv_not_exist'), ErrorCode.NOT_FOUND);
  });

  it('copilot：洞察命中（意图/概率/建议/引用）', async () => {
    const data = await conversations.copilot(adminCtx, convId);
    expect(data.intent).toBe('rfq');
    expect(data.purchaseProbability).toBe(70);
    expect(data.stage).toBe('negotiation');
    expect(data.suggestions).toEqual([{ suggestionId: 'sug_1', label: '发送报价单', checked: false, kind: 'content' }]);
    expect(data.citations).toEqual([{ docId: 'doc_1', docName: '价格表', chunkId: 'chk_1' }]);
  });

  it('copilot：无洞察空态兜底（M5-C4 写回前口径）', async () => {
    const data = await conversations.copilot(adminCtx, convNoInsightId);
    expect(data.intent).toBe('other');
    expect(data.purchaseProbability).toBe(0);
    expect(data.suggestions).toEqual([]);
    expect(data.citations).toEqual([]);
  });

  it('copilot：sales(self) 越权 40301；不存在 40401', async () => {
    await expectBiz(conversations.copilot(salesCtx, convId), ErrorCode.FORBIDDEN);
    await expectBiz(conversations.copilot(adminCtx, 'conv_not_exist'), ErrorCode.NOT_FOUND);
  });
});
