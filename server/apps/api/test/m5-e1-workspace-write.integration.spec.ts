/**
 * M5-E1 06 AI 销售工作台 · 写侧集成测试（后端开发计划表 E1；接口 06 §3.2~§3.5，M5-C1/C2）：
 * - ai-draft 主路径：知识检索依据 → 真实 LLM 产出（结构断言）→ 新草稿消息落库（citations/missingKnowledge）；
 * - regenerate：新建草稿消息（新 message id，不改旧草稿）；
 * - PUT /messages：编辑差异 editedDiff 留痕 / 非 draft 40901 / 空内容 42201；
 * - send 双分支：分支 B（缺省无 autoApprove → approval_request 挂起 + waiting_approval）；
 *   分支 A（role 补 email_send autoApprove → 进入外发出口，无邮箱 42201，证明不再走审批）；
 * - ask-ai：RAG 检索问答 + 无依据兜底文案（D9）；
 * - copilot/suggestions/apply：insert_draft 要点合并（多次追加）/ create_tasks 仅建跟进任务（D8：不产「创建报价」）+ 每客户单进行中任务；
 * - 越权：sales(self) 对他人客户会话写操作全部 40301；sales 可写自己的会话（主路径）。
 * 前置：docker compose up（PG 5432 / Redis 6379）+ 迁移已执行，且已提供 server/.env.test
 * （真实 provider 配置：org 级 AI 模型台账指向真实 LLM，无 mock 兜底）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { BizException, createId, encryptSecret, ErrorCode } from '@tradepilot/core';
import { closeDb, createDb, schema, type Db, type OrgScopeContext } from '@tradepilot/db';
import { EnvService } from '../src/config/env.service.js';
import { testEnv, testLlmOptions } from './setup/providers.js';
import { AuthService } from '../src/auth/auth.service.js';
import { TokenService } from '../src/auth/token.service.js';
import { ConversationsService } from '../src/conversations/conversations.service.js';

process.env.JWT_SECRET ||= 'it_only_test_secret_0123456789abcdef0123456789abcdef';
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.DATABASE_URL ||= 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';

const SUPER_URL = 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';
const APP_URL = 'postgresql://tradepilot_app:changeme_app@localhost:5432/tradepilot';

let superDb: Db;
let appDb: Db;
let redis: Redis;
let conversations: ConversationsService;

let orgId = '';
let adminId = '';
let salesId = '';
let adminCtx: OrgScopeContext;
let salesCtx: OrgScopeContext;

// admin 自有客户/会话（写侧主路径 + 分支 B/A 测试对象）
const CUS_A = createId('cus');
const CONTACT_A = createId('cont');
const CONV_A = createId('conv');
const MSG_IN_A = createId('msg');
const INSIGHT_A = createId('ins');
// sales 自有客户/会话（sales 可写自己的主路径）
const CUS_B = createId('cus');
const CONV_B = createId('conv');
const MSG_IN_B = createId('msg');

// 各用例共享草稿 id
let draft1 = '';
let draft2 = '';

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
    companyName: 'IT M5-E1 工作台写侧租户',
    contactName: '管理员',
    email: `it-m5e1-${createId('org')}@test.com`,
    password: 'password123',
  });
  orgId = session.user.orgId;
  adminId = session.user.userId;

  // sales 成员 fixture（角色/数据范围断言，不经邀请链路）
  salesId = createId('usr');
  await superDb.insert(schema.userAccount).values({
    id: salesId,
    orgId,
    email: `m5e1-sales-${createId('org')}@test.com`,
    passwordHash: 'fixture_no_login',
    name: '销售甲',
    role: 'sales',
    status: 'active',
  });

  adminCtx = { orgId, userId: adminId, role: 'admin', scope: 'all' };
  salesCtx = { orgId, userId: salesId, role: 'sales', scope: 'self' };

  // org 级「AI 模型配置」选用真实 LLM（resolveTarget 台账路径；无 mock 兜底）
  await superDb.insert(schema.aiModel).values({
    id: createId('aim'),
    orgId,
    type: 'llm',
    name: `e1-llm-${createId('aim')}`,
    provider: testLlmOptions.provider,
    model: testLlmOptions.defaultModel,
    baseUrl: testLlmOptions.baseUrl ?? null,
    apiKeyEnc: encryptSecret(testEnv.TEST_LLM_API_KEY, process.env.ENCRYPTION_KEY!),
    temperature: '0.70',
    maxTokens: 4096,
    isSelected: true,
    createdBy: adminId,
  });

  await superDb.insert(schema.customer).values([
    { id: CUS_A, orgId, companyName: 'E1 会话客户 Alpha', country: 'UK', ownerId: adminId },
    { id: CUS_B, orgId, companyName: 'E1 会话客户 Beta', country: 'DE', ownerId: salesId },
  ]);
  await superDb.insert(schema.contact).values({
    id: CONTACT_A,
    orgId,
    customerId: CUS_A,
    name: 'Emma',
    title: 'Buyer',
    email: `emma-${createId('cont')}@example.com`,
  });
  await superDb.insert(schema.conversation).values([
    {
      id: CONV_A,
      orgId,
      customerId: CUS_A,
      contactId: CONTACT_A,
      subject: 'Re: 支架报价',
      priority: 'high',
      unreadCount: 2,
      lastMessageAt: new Date(),
      lastMessagePreview: '请确认交期与起订量',
    },
    {
      id: CONV_B,
      orgId,
      customerId: CUS_B,
      subject: 'Greetings',
      priority: 'normal',
      unreadCount: 0,
      lastMessagePreview: 'Hello',
    },
  ]);
  await superDb.insert(schema.message).values([
    {
      id: MSG_IN_A,
      orgId,
      conversationId: CONV_A,
      direction: 'in',
      senderType: 'contact',
      senderName: CONTACT_A,
      content: '我们需要 5000 件支架的报价，请确认交期与起订量。',
      status: 'sent',
      sentAt: new Date(Date.now() - 3_600_000),
    },
    {
      id: MSG_IN_B,
      orgId,
      conversationId: CONV_B,
      direction: 'in',
      senderType: 'contact',
      senderName: 'buyer@beta.example.com',
      content: 'Could you share your catalog?',
      status: 'sent',
      sentAt: new Date(Date.now() - 86_400_000),
    },
  ]);
  // 洞察行（suggestions/apply 数据源；copilot 读侧契约同源）
  await superDb.insert(schema.conversationInsight).values({
    id: INSIGHT_A,
    orgId,
    conversationId: CONV_A,
    intent: 'rfq',
    purchaseProbability: 70,
    suggestions: [
      { suggestionId: 'sug_a', label: '发送报价单', kind: 'content' },
      { suggestionId: 'sug_b', label: '安排电话会议', kind: 'process' },
    ],
    citations: [],
    generatedAt: new Date(),
  });

  conversations = new ConversationsService(appDb, env);
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
      await tx.delete(schema.aiModel).where(eq(schema.aiModel.orgId, orgId));
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

// ============================== C1 草稿生成 ==============================

describe('M5-E1 · 06 写侧：ai-draft / regenerate / PUT messages（06 §3.2）', () => {
  it('ai-draft 主路径：mock LLM 产出 + 新草稿落库；无知识库命中 → missingKnowledge 兜底', async () => {
    const res = await conversations.aiDraft(adminCtx, CONV_A, { basedOnMessageId: MSG_IN_A });

    expect(res.draftId).toBeTruthy();
    expect(res.basedOnMessageId).toBe(MSG_IN_A);
    // 真实 LLM 产出：仅断言结构（正文非空），不再断言确定性文案
    expect(res.content.length).toBeGreaterThan(0);
    expect(res.generatedAt).toBeTruthy();
    // org 无知识文档 → citations 空 + missingKnowledge 标记（D9 红线）
    expect(res.citations).toEqual([]);
    expect(res.missingKnowledge).toBe(true);
    draft1 = res.draftId;

    const [row] = await superDb.select().from(schema.message).where(eq(schema.message.id, draft1));
    expect(row).toMatchObject({
      orgId,
      conversationId: CONV_A,
      direction: 'out',
      senderType: 'ai',
      status: 'draft',
      basedOnMessageId: MSG_IN_A,
    });
  });

  it('regenerate：新草稿消息（新 id），旧草稿不被修改', async () => {
    const res = await conversations.regenerate(adminCtx, CONV_A, { basedOnMessageId: MSG_IN_A });
    expect(res.draftId).not.toBe(draft1);
    draft2 = res.draftId;

    const [old] = await superDb.select().from(schema.message).where(eq(schema.message.id, draft1));
    expect(old?.status).toBe('draft'); // 旧草稿未被 regenerate 覆盖
    const [neu] = await superDb.select().from(schema.message).where(eq(schema.message.id, draft2));
    expect(neu?.status).toBe('draft');
  });

  it('PUT /messages：编辑差异留痕；非 draft → 40901；空内容 → 42201', async () => {
    const [beforeRow] = await superDb
      .select({ content: schema.message.content })
      .from(schema.message)
      .where(eq(schema.message.id, draft1));
    const originalContent = beforeRow?.content ?? '';

    const edited = await conversations.updateMessage(adminCtx, draft1, {
      content: '已编辑：确认 5000 件，交期 30 天。',
    });
    expect(edited.status).toBe('draft');

    const [row] = await superDb
      .select({ content: schema.message.content, editedDiff: schema.message.editedDiff })
      .from(schema.message)
      .where(eq(schema.message.id, draft1));
    expect(row?.content).toBe('已编辑：确认 5000 件，交期 30 天。');
    expect(row?.editedDiff).toEqual([
      { field: 'content', before: originalContent, after: '已编辑：确认 5000 件，交期 30 天。' },
    ]);

    // 未变化内容编辑 → 不产生 diff
    const noop = await conversations.updateMessage(adminCtx, draft1, {
      content: '已编辑：确认 5000 件，交期 30 天。',
    });
    void noop;
    const [row2] = await superDb
      .select({ editedDiff: schema.message.editedDiff })
      .from(schema.message)
      .where(eq(schema.message.id, draft1));
    expect(row2?.editedDiff).toHaveLength(1); // 保持首次 diff，不追加

    await expectBiz(
      conversations.updateMessage(adminCtx, draft1, { content: '   ' }),
      ErrorCode.BIZ_VALIDATION,
    );
    // 对 in 消息（sent）编辑 → 40901
    await expectBiz(
      conversations.updateMessage(adminCtx, MSG_IN_A, { content: '篡改来信' }),
      ErrorCode.CONFLICT,
    );
  });
});

// ============================== C1 send 双分支 ==============================

describe('M5-E1 · 06 写侧：send 分支 B（审批挂起，06 §3.3）', () => {
  it('缺省无 autoApprove：draft → waiting_approval + approval_request(email_send/pending)；重复 send → 40901', async () => {
    const res = await conversations.send(adminCtx, CONV_A, { messageId: draft2 });
    expect(res.status).toBe('draft');
    expect(res.approval).toMatchObject({ approvalType: 'email_send', status: 'pending' });

    const [msg] = await superDb
      .select({ status: schema.message.status })
      .from(schema.message)
      .where(eq(schema.message.id, draft2));
    expect(msg?.status).toBe('waiting_approval');

    const appr = await superDb
      .select()
      .from(schema.approvalRequest)
      .where(eq(schema.approvalRequest.bizId, draft2))
      .limit(1);
    expect(appr[0]).toMatchObject({
      orgId,
      approvalType: 'email_send',
      riskLevel: 'medium',
      bizType: 'message',
      status: 'pending',
    });
    expect(appr[0]?.context).toMatchObject({ conversationId: CONV_A });

    // 已提交审批不可重复发送；waiting_approval 也不可再编辑
    await expectBiz(
      conversations.send(adminCtx, CONV_A, { messageId: draft2 }),
      ErrorCode.CONFLICT,
    );
    await expectBiz(
      conversations.updateMessage(adminCtx, draft2, { content: 'x' }),
      ErrorCode.CONFLICT,
    );
  });
});

describe('M5-E1 · 06 写侧：send 分支 A（autoApprove 直发出口，06 §3.3）', () => {
  it('role 补 email_send autoApprove：不再走审批，进入外发出口；无可用邮箱 → 42201', async () => {
    // admin 审批规则追加 autoApprove（对齐 Runner 快照口径）
    const [perm] = await superDb
      .select({ approvalRules: schema.rolePermission.approvalRules })
      .from(schema.rolePermission)
      .where(eq(schema.rolePermission.orgId, orgId))
      .where(eq(schema.rolePermission.role, 'admin'))
      .limit(1);
    await superDb
      .update(schema.rolePermission)
      .set({
        approvalRules: [
          ...(perm?.approvalRules ?? []),
          {
            approvalType: 'email_send' as const,
            approverRoles: ['admin'] as string[],
            autoApprove: true,
          },
        ],
      })
      .where(eq(schema.rolePermission.orgId, orgId))
      .where(eq(schema.rolePermission.role, 'admin'));

    // 新草稿 → send：autoApprove 判定进入分支 A（外发），因无 connected 邮箱抛 42201
    // （若误走分支 B 会返回 approval 而非抛错——本断言即验证分支选择）
    const draft = await conversations.aiDraft(adminCtx, CONV_A, { basedOnMessageId: MSG_IN_A });
    const err = await expectBiz(
      conversations.send(adminCtx, CONV_A, { messageId: draft.draftId }),
      ErrorCode.BIZ_VALIDATION,
    );
    expect(err.message).toContain('邮箱');
    const [msg] = await superDb
      .select({ status: schema.message.status })
      .from(schema.message)
      .where(eq(schema.message.id, draft.draftId));
    expect(msg?.status).toBe('draft'); // 失败不置 sent，仍可重试
  });
});

// ============================== C2 ask-ai / suggestions/apply ==============================

describe('M5-E1 · 06 写侧：ask-ai + suggestions/apply（06 §3.4~§3.5）', () => {
  it('ask-ai：拼接会话上下文 + 知识库依据；无依据 → 兜底文案（D9 禁止编造）', async () => {
    const res = await conversations.askAi(adminCtx, CONV_A, { question: 'MOQ 是多少？' });
    expect(res.answer).toContain('MOQ 是多少？');
    expect(res.answer).toContain('会话上下文');
    // org 无知识文档 → 兜底提示
    expect(res.answer).toContain('知识库暂无相关依据');
    expect(res.citations).toEqual([]);
  });

  it('apply insert_draft：无草稿先建、再执行追加合并；勾选不存在建议 → 42201', async () => {
    const first = await conversations.applySuggestions(adminCtx, {
      conversationId: CONV_A,
      suggestionIds: ['sug_a'],
      mode: 'insert_draft',
    });
    expect(first.draftContent).toContain('发送报价单');

    const second = await conversations.applySuggestions(adminCtx, {
      conversationId: CONV_A,
      suggestionIds: ['sug_b'],
      mode: 'insert_draft',
    });
    // 存在草稿时以追加方式合并（editedDiff 留痕），而非覆盖
    expect(second.draftContent).toContain('【要点补充】');
    expect(second.draftContent).toContain('安排电话会议');

    const [draftRow] = await superDb
      .select({ content: schema.message.content, editedDiff: schema.message.editedDiff })
      .from(schema.message)
      .where(eq(schema.message.conversationId, CONV_A))
      .where(eq(schema.message.direction, 'out'))
      .where(eq(schema.message.status, 'draft'))
      .orderBy(desc(schema.message.createdAt))
      .limit(1);
    expect(draftRow?.content).toContain('发送报价单');
    expect(draftRow?.content).toContain('【要点补充】'); // 合并进既有草稿（追加模式，非覆盖）
    expect(draftRow?.editedDiff).toBeTruthy();

    await expectBiz(
      conversations.applySuggestions(adminCtx, {
        conversationId: CONV_A,
        suggestionIds: ['sug_nope'],
        mode: 'insert_draft',
      }),
      ErrorCode.BIZ_VALIDATION,
    );
  });

  it('apply create_tasks：流程型仅建 follow_up_task（D8：不产「创建报价」）；重复 → 返回既有（每客户单进行中）', async () => {
    const first = await conversations.applySuggestions(adminCtx, {
      conversationId: CONV_A,
      suggestionIds: ['sug_b'],
      mode: 'create_tasks',
    });
    expect(first.taskIds).toHaveLength(1);
    const taskId = first.taskIds![0];

    const rows = await superDb
      .select({
        id: schema.followUpTask.id,
        status: schema.followUpTask.status,
        customerId: schema.followUpTask.customerId,
      })
      .from(schema.followUpTask)
      .where(eq(schema.followUpTask.orgId, orgId))
      .where(eq(schema.followUpTask.customerId, CUS_A));
    const active = rows.filter((r) =>
      ['ready', 'scheduled', 'waiting_approval'].includes(r.status),
    );
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(taskId);

    // 每客户仅 1 个进行中任务：重复 create_tasks 返回既有任务（幂等）
    const again = await conversations.applySuggestions(adminCtx, {
      conversationId: CONV_A,
      suggestionIds: ['sug_b'],
      mode: 'create_tasks',
    });
    expect(again.taskIds).toEqual([taskId]);
  });
});

// ============================== 越权 / 参数校验 ==============================

describe('M5-E1 · 越权与参数校验（40301 / 40001 / 40401）', () => {
  it('sales(self) 对他人客户会话全部写操作 → 40301', async () => {
    await expectBiz(
      conversations.aiDraft(salesCtx, CONV_A, { basedOnMessageId: MSG_IN_A }),
      ErrorCode.FORBIDDEN,
    );
    await expectBiz(
      conversations.regenerate(salesCtx, CONV_A, { basedOnMessageId: MSG_IN_A }),
      ErrorCode.FORBIDDEN,
    );
    await expectBiz(
      conversations.send(salesCtx, CONV_A, { messageId: draft1 }),
      ErrorCode.FORBIDDEN,
    );
    await expectBiz(conversations.askAi(salesCtx, CONV_A, { question: 'hi' }), ErrorCode.FORBIDDEN);
    await expectBiz(
      conversations.updateMessage(salesCtx, draft1, { content: '越权' }),
      ErrorCode.FORBIDDEN,
    );
    await expectBiz(
      conversations.applySuggestions(salesCtx, {
        conversationId: CONV_A,
        suggestionIds: ['sug_a'],
        mode: 'insert_draft',
      }),
      ErrorCode.FORBIDDEN,
    );
  });

  it('sales 可写自己的会话（主路径：ai-draft 成功）', async () => {
    const res = await conversations.aiDraft(salesCtx, CONV_B, { basedOnMessageId: MSG_IN_B });
    expect(res.draftId).toBeTruthy();
    expect(res.content.length).toBeGreaterThan(0);
  });

  it('basedOnMessageId 不存在 → 40401；不属于该会话 → 40001', async () => {
    await expectBiz(
      conversations.aiDraft(adminCtx, CONV_A, { basedOnMessageId: 'msg_not_exist' }),
      ErrorCode.NOT_FOUND,
    );
    await expectBiz(
      conversations.aiDraft(adminCtx, CONV_A, { basedOnMessageId: MSG_IN_B }),
      ErrorCode.BAD_REQUEST,
    );
  });
});
