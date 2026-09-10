import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pino from 'pino';
import { BizException, createId } from '@tradepilot/core';
import { closeDb, createDb, schema, type Db } from '@tradepilot/db';
import {
  configureEmbedding,
  configureObjectStorage,
  MockEmbeddingProvider,
  type ObjectStorage,
} from '@tradepilot/integrations';
import { EnvService } from '../src/config/env.service.js';
import { KnowledgeService } from '../src/knowledge/knowledge.service.js';
import { ApprovalsService } from '../src/approvals/approvals.service.js';

/**
 * M4 #9/#10 11 知识中心 + 12 审核中心服务集成用例（后端开发计划表 M4，接口 11/12 契约）：
 * - 11 知识中心：上传（白名单/magic number）→ 列表 → 混合检索 citations（pgvector+tsquery+trgm+RRF）
 *   → stats → detail → 软删（chunk 物理清除 + 检索实时失效）→ 重复删除 40901 → retry 语义；
 * - 12 审核中心：summary/list/detail → approve（task 恢复 running + log 留痕）→
 *   edited_approved（字段级 editedDiff）→ reject（级联 failed(approval_rejected) + follow_up paused
 *   + 员工回 idle）→ expired 处置 42201 → 重复处置 40901 → logs。
 * 前置：docker compose up（PG 5432 / Redis 6380）+ `pnpm --filter @tradepilot/db migrate` + tradepilot_app 角色。
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
let knowledge: KnowledgeService;
let approvals: ApprovalsService;

// ===== 知识中心租户 =====
const ORG_K = createId('org');
const UPLOADER = createId('usr');
let docId = '';

// ===== 审核中心租户 =====
const ORG_A = createId('org');
const APPROVER = createId('usr');
const EMP_1 = createId('aie');
const EMP_2 = createId('aie');
const TASK_APPROVE = createId('task');
const TASK_REJECT = createId('task');
const APR_APPROVE = createId('apr');
const APR_EDIT = createId('apr');
const APR_REJECT = createId('apr');
const APR_EXPIRED = createId('apr');
const APR_CD = createId('apr');
const FT_REJECT = createId('ftask');
const CUS_REJECT = createId('cus');
const STRAT = createId('fstr');

const DOC_TEXT = Buffer.from(
  `# 产品知识：LED 灯带\n\n我们的 LED 灯带支持 IP67 防水，通过 CE 认证。最小起订量 500 米。\n`,
  'utf8',
);

/** 进程内对象存储 stub（M4 测试口径：不依赖 MinIO 状态） */
const objects = new Map<string, Buffer>();
const memoryStorage: ObjectStorage = {
  async putObject(key, body) {
    objects.set(key, body);
  },
  async getObject(key) {
    const hit = objects.get(key);
    if (!hit) {
      throw new Error(`对象不存在: ${key}`);
    }
    return hit;
  },
  async ensureBucket() {},
};

async function expectBizError(p: Promise<unknown>, code: number): Promise<void> {
  try {
    await p;
    expect.fail(`应抛出错误码 ${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(BizException);
    expect((e as BizException).code).toBe(code);
  }
}

beforeAll(async () => {
  superDb = createDb(SUPER_URL, { max: 2 });
  appDb = createDb(APP_URL, { max: 5 });
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
  configureObjectStorage(memoryStorage);
  configureEmbedding(new MockEmbeddingProvider());
  const env = new EnvService();
  knowledge = new KnowledgeService(appDb, env);
  approvals = new ApprovalsService(appDb, redis, logger, env);

  await superDb.transaction(async (tx) => {
    // ===== 知识中心租户 =====
    await tx
      .insert(schema.org)
      .values({ id: ORG_K, name: 'M4 知识租户', timezone: 'Asia/Shanghai' });
    await tx.insert(schema.userAccount).values({
      id: UPLOADER,
      orgId: ORG_K,
      email: `m4k-${ORG_K.slice(-6)}@test.com`,
      passwordHash: 'x',
      name: '知识管理员',
      role: 'admin',
      status: 'active',
    });
    // ===== 审核中心租户 =====
    await tx
      .insert(schema.org)
      .values({ id: ORG_A, name: 'M4 审核租户', timezone: 'Asia/Shanghai' });
    await tx.insert(schema.userAccount).values([
      {
        id: APPROVER,
        orgId: ORG_A,
        email: `m4a-${ORG_A.slice(-6)}@test.com`,
        passwordHash: 'x',
        name: '审批管理员',
        role: 'admin',
        status: 'active',
      },
    ]);
    await tx.insert(schema.aiEmployee).values([
      {
        id: EMP_1,
        orgId: ORG_A,
        role: 'sales',
        name: 'AI 销售员',
        goal: '回复客户邮件',
        tools: ['email_send'],
        permissions: {},
        approvalPolicy: { email_send: 'high_value_only', quote: 'always', autoExecute: [] },
        kpiConfig: [],
        status: 'waiting_approval',
        currentTaskId: TASK_APPROVE,
      },
      {
        id: EMP_2,
        orgId: ORG_A,
        role: 'sales',
        name: 'AI 跟进员',
        goal: '按策略跟进客户',
        tools: ['email_send'],
        permissions: {},
        approvalPolicy: { email_send: 'high_value_only', quote: 'always', autoExecute: [] },
        kpiConfig: [],
        status: 'waiting_approval',
        currentTaskId: TASK_REJECT,
      },
    ]);
    await tx.insert(schema.aiTask).values([
      {
        id: TASK_APPROVE,
        orgId: ORG_A,
        employeeId: EMP_1,
        type: 'email_reply',
        title: '回复来信（批准用）',
        status: 'waiting_approval',
        input: { conversationId: createId('conv') },
      },
      {
        id: TASK_REJECT,
        orgId: ORG_A,
        employeeId: EMP_2,
        type: 'follow_up',
        title: '跟进触达（拒绝用）',
        status: 'waiting_approval',
        input: { followUpTaskId: FT_REJECT, customerId: CUS_REJECT },
      },
    ]);
    await tx.insert(schema.customer).values({
      id: CUS_REJECT,
      orgId: ORG_A,
      companyName: '审核测试客户',
      country: 'US',
      ownerId: APPROVER,
    });
    await tx.insert(schema.followUpStrategy).values({
      id: STRAT,
      orgId: ORG_A,
      name: '审核测试策略',
      targetScope: {},
      autoSendPolicy: 'auto_send',
    });
    await tx.insert(schema.followUpTask).values({
      id: FT_REJECT,
      orgId: ORG_A,
      customerId: CUS_REJECT,
      strategyId: STRAT,
      status: 'waiting_approval',
      nextRunAt: new Date(),
    });
    await tx.insert(schema.approvalRequest).values([
      {
        id: APR_APPROVE,
        orgId: ORG_A,
        approvalType: 'email_send',
        riskLevel: 'medium',
        title: '回复邮件发送审批',
        bizType: 'ai_task',
        bizId: TASK_APPROVE,
        context: { conversationId: createId('conv') },
        aiProposal: { nodeId: 'email_send', subject: 'Mock 主题', body: '原稿正文' },
        requestedByEmployeeId: EMP_1,
        linkedTaskId: TASK_APPROVE,
        expiresAt: new Date(Date.now() + 48 * 3600_000),
      },
      {
        id: APR_EDIT,
        orgId: ORG_A,
        approvalType: 'email_send',
        riskLevel: 'medium',
        title: '回复邮件编辑审批',
        bizType: 'ai_task',
        bizId: createId('task'),
        context: {},
        aiProposal: { nodeId: 'email_send', subject: '编辑主题', body: '编辑原稿' },
        expiresAt: new Date(Date.now() + 48 * 3600_000),
      },
      {
        id: APR_REJECT,
        orgId: ORG_A,
        approvalType: 'email_send',
        riskLevel: 'medium',
        title: '跟进邮件拒绝审批',
        bizType: 'ai_task',
        bizId: TASK_REJECT,
        context: {},
        aiProposal: { nodeId: 'email_send', subject: '跟进主题', body: '跟进正文' },
        requestedByEmployeeId: EMP_2,
        linkedTaskId: TASK_REJECT,
        expiresAt: new Date(Date.now() + 48 * 3600_000),
      },
      {
        id: APR_EXPIRED,
        orgId: ORG_A,
        approvalType: 'email_send',
        riskLevel: 'medium',
        title: '已超时审批',
        bizType: 'ai_task',
        bizId: createId('task'),
        context: {},
        aiProposal: { nodeId: 'email_send', subject: '超时', body: '超时正文' },
        status: 'expired',
        expiresAt: new Date(Date.now() - 3600_000),
      },
      {
        id: APR_CD,
        orgId: ORG_A,
        approvalType: 'customer_delete',
        riskLevel: 'high',
        title: '客户删除审批',
        bizType: 'customer',
        bizId: createId('cus'),
        context: {},
        aiProposal: {},
        expiresAt: new Date(Date.now() + 48 * 3600_000),
      },
    ]);
  });
}, 30_000);

afterAll(async () => {
  await superDb.transaction(async (tx) => {
    for (const orgId of [ORG_K, ORG_A]) {
      await tx.delete(schema.knowledgeChunk).where(eq(schema.knowledgeChunk.orgId, orgId));
      await tx.delete(schema.knowledgeDocument).where(eq(schema.knowledgeDocument.orgId, orgId));
      await tx.delete(schema.approvalLog).where(eq(schema.approvalLog.orgId, orgId));
      await tx.delete(schema.approvalRequest).where(eq(schema.approvalRequest.orgId, orgId));
      await tx.delete(schema.aiTask).where(eq(schema.aiTask.orgId, orgId));
      await tx.delete(schema.followUpTask).where(eq(schema.followUpTask.orgId, orgId));
      await tx.delete(schema.followUpStrategy).where(eq(schema.followUpStrategy.orgId, orgId));
      await tx.delete(schema.customer).where(eq(schema.customer.orgId, orgId));
      await tx.delete(schema.aiEmployee).where(eq(schema.aiEmployee.orgId, orgId));
      await tx.delete(schema.userAccount).where(eq(schema.userAccount.orgId, orgId));
      await tx.delete(schema.org).where(eq(schema.org.id, orgId));
    }
  });
  await redis.quit();
  await closeDb(appDb);
  await closeDb(superDb);
});

describe('M4 #9 · 11 知识中心', () => {
  it('上传：md 文本 → docId + status=indexing + 对象已存', async () => {
    const result = await knowledge.upload(
      ORG_K,
      UPLOADER,
      { originalname: 'led-knowledge.md', size: DOC_TEXT.length, buffer: DOC_TEXT },
      { category: 'product', source: 'upload' },
    );
    expect(result.status).toBe('indexing');
    docId = result.docId;

    const [doc] = await superDb
      .select({ id: schema.knowledgeDocument.id, status: schema.knowledgeDocument.status })
      .from(schema.knowledgeDocument)
      .where(eq(schema.knowledgeDocument.id, docId));
    expect(doc?.status).toBe('indexing');
  });

  it('上传拒绝：白名单外扩展名 / 伪装 pdf（magic number 校验）', async () => {
    await expectBizError(
      knowledge.upload(
        ORG_K,
        UPLOADER,
        { originalname: 'evil.exe', size: 10, buffer: Buffer.from('MZ') },
        { category: 'other', source: 'upload' },
      ),
      42201,
    );
    await expectBizError(
      knowledge.upload(
        ORG_K,
        UPLOADER,
        { originalname: 'fake.pdf', size: 10, buffer: Buffer.from('not a pdf') },
        { category: 'other', source: 'upload' },
      ),
      42201,
    );
  });

  it('列表 + 统计（含模拟索引产物 chunk）', async () => {
    // 模拟索引产物（流水线见 worker 侧 m4-knowledge-index 集成用例）
    const embedding = new MockEmbeddingProvider();
    const [vector] = await embedding.embed([DOC_TEXT.toString('utf8')]);
    await superDb.transaction(async (tx) => {
      await tx.insert(schema.knowledgeChunk).values({
        id: createId('kchk'),
        orgId: ORG_K,
        documentId: docId,
        chunkIndex: 0,
        content: 'Our LED strips are IP67 waterproof and CE certified. MOQ 500 meters.',
        tokenCount: 20,
        embedding: vector,
        metadata: { headingPath: ['产品知识：LED 灯带'] },
      });
      await tx
        .update(schema.knowledgeDocument)
        .set({ status: 'indexed', indexedAt: new Date() })
        .where(eq(schema.knowledgeDocument.id, docId));
    });

    const list = await knowledge.list(ORG_K, { page: 1, pageSize: 10 });
    expect(list.total).toBe(1);
    expect(list.items[0]?.docId).toBe(docId);
    expect(list.items[0]?.status).toBe('indexed');

    const stats = await knowledge.stats(ORG_K);
    expect(stats.documentsCount).toBe(1);
    expect(stats.chunksCount).toBe(1);
    expect(stats.lastIndexedAt).toBeTruthy();
  });

  it('混合检索带 citations：results 命中 + docId/docName/category/score', async () => {
    const result = await knowledge.search(ORG_K, {
      query: 'LED strips waterproof',
      topK: 5,
    });
    expect(result.noResult).toBe(false);
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    const top = result.results[0]!;
    expect(top.docId).toBe(docId);
    expect(top.docName).toBe('led-knowledge.md');
    expect(top.category).toBe('product');
    expect(top.score).toBeGreaterThan(0);
  });

  it('详情 + 软删：deletedAt/deletedBy 留痕 + chunk 物理清除 + 检索实时失效', async () => {
    const detail = await knowledge.detail(ORG_K, docId);
    expect(detail.deleted).toBe(false);
    expect(detail.updatedBy).toBe('知识管理员');

    const removed = await knowledge.remove(ORG_K, UPLOADER, docId);
    expect(removed.deleted).toBe(true);

    const chunks = await superDb
      .select({ id: schema.knowledgeChunk.id })
      .from(schema.knowledgeChunk)
      .where(eq(schema.knowledgeChunk.documentId, docId));
    expect(chunks).toHaveLength(0);

    const [doc] = await superDb
      .select({
        deletedAt: schema.knowledgeDocument.deletedAt,
        deletedBy: schema.knowledgeDocument.deletedBy,
      })
      .from(schema.knowledgeDocument)
      .where(eq(schema.knowledgeDocument.id, docId));
    expect(doc?.deletedAt).toBeTruthy();
    expect(doc?.deletedBy).toBe(UPLOADER);

    // 检索实时失效（引用不可命中）
    const after = await knowledge.search(ORG_K, { query: 'LED strips waterproof', topK: 5 });
    expect(after.noResult).toBe(true);

    // 软删回溯（detail 不受已删过滤约束）
    const deletedDetail = await knowledge.detail(ORG_K, docId);
    expect(deletedDetail.deleted).toBe(true);
    expect(deletedDetail.deletedBy).toBe('知识管理员');
  });

  it('重复删除 40901；retry 仅 failed 可重试', async () => {
    await expectBizError(knowledge.remove(ORG_K, UPLOADER, docId), 40901);

    // 非 failed 状态重试 → 40901
    const upload2 = await knowledge.upload(
      ORG_K,
      UPLOADER,
      { originalname: 'retry-doc.md', size: DOC_TEXT.length, buffer: DOC_TEXT },
      { category: 'faq', source: 'upload' },
    );
    await expectBizError(knowledge.retry(ORG_K, upload2.docId), 40901);

    // failed → retry → indexing + retryCount+1
    await superDb
      .update(schema.knowledgeDocument)
      .set({ status: 'failed', error: '嵌入服务超时' })
      .where(eq(schema.knowledgeDocument.id, upload2.docId));
    const retried = await knowledge.retry(ORG_K, upload2.docId);
    expect(retried.status).toBe('indexing');
    const [doc] = await superDb
      .select({
        status: schema.knowledgeDocument.status,
        retryCount: schema.knowledgeDocument.retryCount,
      })
      .from(schema.knowledgeDocument)
      .where(eq(schema.knowledgeDocument.id, upload2.docId));
    expect(doc?.status).toBe('indexing');
    expect(doc?.retryCount).toBe(1);
  });
});

describe('M4 #10 · 12 审核中心', () => {
  it('summary：all + P0 常驻类型 + count>0 类型 Tab（12 §3.1）', async () => {
    const result = await approvals.summary(ORG_A);
    const all = result.tabs.find((t) => t.type === 'all');
    expect(all?.count).toBe(4); // APPROVE/EDIT/REJECT pending + CD pending（EXPIRED 不计）
    expect(result.tabs.some((t) => t.type === 'email_send' && t.count === 3)).toBe(true);
    expect(result.tabs.some((t) => t.type === 'customer_delete' && t.count === 1)).toBe(true);
  });

  it('list：status 筛选 + 卡片字段；detail 不存在 40401', async () => {
    const pending = await approvals.list(ORG_A, { status: 'pending', page: 1, pageSize: 10 });
    expect(pending.total).toBe(4);
    const card = pending.items.find((i) => i['approvalId'] === APR_APPROVE) as Record<
      string,
      unknown
    >;
    expect(card['approvalType']).toBe('email_send');
    expect(card['riskLevel']).toBe('medium');
    expect((card['aiProposal'] as Record<string, unknown>)['nodeId']).toBe('email_send');

    await expectBizError(approvals.detail(ORG_A, 'not-exist'), 40401);
  });

  it('approve：pending → approved + approval_log + 任务恢复 running（resume 重投）', async () => {
    const result = await approvals.approve(ORG_A, APPROVER, APR_APPROVE, { action: 'approve' });
    expect(result.status).toBe('approved');
    expect(result.resultRef).toEqual({ taskId: TASK_APPROVE });

    const [task] = await superDb
      .select({ status: schema.aiTask.status })
      .from(schema.aiTask)
      .where(eq(schema.aiTask.id, TASK_APPROVE));
    expect(task?.status).toBe('running');

    const logs = await approvals.logs(ORG_A, APR_APPROVE);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.action).toBe('approved');
    expect(logs[0]?.approverName).toBe('审批管理员');
  });

  it('edited_approved：字段级合并 + editedDiff 留痕', async () => {
    const result = await approvals.approve(ORG_A, APPROVER, APR_EDIT, {
      action: 'edited_approved',
      editedContent: { aiProposal: { body: '编辑后正文' } },
    });
    expect(result.status).toBe('edited_approved');

    const [req] = await superDb
      .select({ aiProposal: schema.approvalRequest.aiProposal })
      .from(schema.approvalRequest)
      .where(eq(schema.approvalRequest.id, APR_EDIT));
    expect(req?.aiProposal).toMatchObject({ subject: '编辑主题', body: '编辑后正文' });

    const logs = await approvals.logs(ORG_A, APR_EDIT);
    const diff = logs[0]?.editedDiff as { field: string; before: string; after: string }[];
    expect(diff).toEqual([{ field: 'aiProposal.body', before: '编辑原稿', after: '编辑后正文' }]);
  });

  it('reject：级联 failed(approval_rejected) + 员工回 idle + follow_up paused + rejectReason 留痕', async () => {
    const result = await approvals.reject(ORG_A, APPROVER, APR_REJECT, {
      reason: '客户刚已回复，无需机器跟进',
    });
    expect(result.status).toBe('rejected');

    const [task] = await superDb
      .select({ status: schema.aiTask.status, error: schema.aiTask.error })
      .from(schema.aiTask)
      .where(eq(schema.aiTask.id, TASK_REJECT));
    expect(task?.status).toBe('failed');
    expect(task?.error).toBe('approval_rejected');

    const [emp] = await superDb
      .select({ status: schema.aiEmployee.status })
      .from(schema.aiEmployee)
      .where(eq(schema.aiEmployee.id, EMP_2));
    expect(emp?.status).toBe('idle');

    const [ft] = await superDb
      .select({ status: schema.followUpTask.status })
      .from(schema.followUpTask)
      .where(eq(schema.followUpTask.id, FT_REJECT));
    expect(ft?.status).toBe('paused');

    const logs = await approvals.logs(ORG_A, APR_REJECT);
    expect(logs[0]?.action).toBe('rejected');
    expect(logs[0]?.rejectReason).toBe('客户刚已回复，无需机器跟进');
  });

  it('expired 处置 42201；已处置重复处置 40901', async () => {
    await expectBizError(
      approvals.approve(ORG_A, APPROVER, APR_EXPIRED, { action: 'approve' }),
      42201,
    );
    await expectBizError(
      approvals.reject(ORG_A, APPROVER, APR_EXPIRED, { reason: '晚到的处置' }),
      42201,
    );
    await expectBizError(
      approvals.approve(ORG_A, APPROVER, APR_APPROVE, { action: 'approve' }),
      40901,
    );
  });
});
