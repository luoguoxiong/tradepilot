import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { closeDb, createDb, schema, type Db } from '@tradepilot/db';
import { createId } from '@tradepilot/core';
import {
  configureEmbedding,
  configureObjectStorage,
  MockEmbeddingProvider,
  type ObjectStorage,
} from '@tradepilot/integrations';
import { KnowledgeIndexProcessor } from '../src/queues/knowledge-index.js';

/**
 * M4 #7 知识入库流水线集成用例（C3，后端技术方案 07 §2 / 11 §7.2）：
 * - 取原文 → parse（md 直读）→ clean → chunk → embed（MockEmbeddingProvider 确定性 1536 维）
 *   → 事务落库（旧 chunk 物理清除 + status='indexed'）；
 * - retry 重跑幂等（chunk 数一致）；
 * - 软删后迟到 job → skipped（引用实时失效语义）；
 * - 不存在文档 → skipped；
 * - 存储取文失败 → failed + error 留痕（11 retry 入口可见）。
 * 前置：docker compose up（PG 5432）+ `pnpm --filter @tradepilot/db migrate`。
 */

const SUPER_URL =
  process.env.TEST_SUPER_DATABASE_URL ??
  'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';

const logger = pino({ level: process.env.TEST_LOG_LEVEL ?? 'silent' });

let db: Db;
let processor: KnowledgeIndexProcessor;

const ORG = createId('org');
const DOC_OK = createId('kdoc');
const DOC_DELETED = createId('kdoc');
const DOC_BROKEN = createId('kdoc');

// 注意：不能重复相同文本行构造多节——clean 会把「出现 ≥3 次的短行」当页眉页脚剔除。
// 此处按真实文档构造分节内容（标题与正文均不同），保证清洗后仍有可索引内容。
const DOC_SECTION = (n: number, spec: string, moq: string) =>
  `## 第 ${n} 节：LED 灯带系列规格

我们的 LED 灯带通过 ${n === 1 ? 'CE' : n === 2 ? 'RoHS' : 'UL'} 认证，${spec}。

最小起订量 ${moq}，交期 ${10 + n}~${15 + n} 天，支持 OEM/ODM 定制。
`;
const DOC_TEXT = `# 产品知识：LED 灯带系列

${DOC_SECTION(1, '防水等级 IP67，12V 输入，每米 60 灯珠，色温 2700K~4000K', '500 米')}

${DOC_SECTION(2, '防水等级 IP65，24V 输入，每米 120 灯珠，色温 4000K~6500K', '300 米')}

${DOC_SECTION(3, '防水等级 IP20（室内款），12V/24V 可选，每米 96 灯珠，RGB 幻彩', '200 米')}`;

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

async function insertDoc(id: string, fileName: string, deleted = false): Promise<void> {
  await db.insert(schema.knowledgeDocument).values({
    id,
    orgId: ORG,
    fileName,
    category: 'product',
    fileType: fileName.split('.').pop() ?? 'md',
    size: DOC_TEXT.length,
    fileUrl: `kdoc/${ORG}/${id}.md`,
    status: 'indexing',
    source: 'upload',
    uploadedBy: null,
    ...(deleted ? { deletedAt: new Date(), deletedBy: null } : {}),
  });
  objects.set(`kdoc/${ORG}/${id}.md`, Buffer.from(DOC_TEXT, 'utf8'));
}

beforeAll(async () => {
  db = createDb(SUPER_URL, { max: 5 });
  configureObjectStorage(memoryStorage);
  configureEmbedding(new MockEmbeddingProvider());
  processor = new KnowledgeIndexProcessor({ db, logger });

  await db.transaction(async (tx) => {
    await tx.insert(schema.org).values({
      id: ORG,
      name: 'M4 知识索引租户',
      timezone: 'Asia/Shanghai',
    });
  });
  await insertDoc(DOC_OK, 'led-knowledge.md');
  await insertDoc(DOC_DELETED, 'deleted-doc.md', true);
  await insertDoc(DOC_BROKEN, 'broken-doc.md');
  // BROKEN：存储缺对象 → getObject 抛错（failed 路径）
  objects.delete(`kdoc/${ORG}/${DOC_BROKEN}.md`);
});

afterAll(async () => {
  await db.transaction(async (tx) => {
    await tx.delete(schema.knowledgeChunk).where(eq(schema.knowledgeChunk.orgId, ORG));
    await tx.delete(schema.knowledgeDocument).where(eq(schema.knowledgeDocument.orgId, ORG));
    await tx.delete(schema.org).where(eq(schema.org.id, ORG));
  });
  await closeDb(db);
});

describe('M4 #7 知识入库流水线（q:knowledge_index）', () => {
  it('md 文档：parse→chunk→embed→落库，status=indexed + embedding 1536 维', async () => {
    const outcome = await processor.process(DOC_OK);
    expect(outcome.status).toBe('indexed');
    expect(outcome.chunks).toBeGreaterThanOrEqual(1);

    const chunks = await db
      .select({
        id: schema.knowledgeChunk.id,
        chunkIndex: schema.knowledgeChunk.chunkIndex,
        content: schema.knowledgeChunk.content,
        tokenCount: schema.knowledgeChunk.tokenCount,
        embedding: schema.knowledgeChunk.embedding,
        metadata: schema.knowledgeChunk.metadata,
      })
      .from(schema.knowledgeChunk)
      .where(eq(schema.knowledgeChunk.documentId, DOC_OK))
      .orderBy(schema.knowledgeChunk.chunkIndex);
    expect(chunks.length).toBe(outcome.chunks);
    expect(chunks[0]!.content).toContain('LED');
    expect(chunks[0]!.embedding).toHaveLength(1536);
    expect(chunks[0]!.tokenCount).toBeGreaterThan(0);

    const [doc] = await db
      .select({ status: schema.knowledgeDocument.status, error: schema.knowledgeDocument.error })
      .from(schema.knowledgeDocument)
      .where(eq(schema.knowledgeDocument.id, DOC_OK));
    expect(doc?.status).toBe('indexed');
    expect(doc?.error).toBeNull();
  });

  it('retry 重跑幂等：旧 chunk 物理清除后重插，数量一致', async () => {
    const first = await processor.process(DOC_OK);
    const second = await processor.process(DOC_OK);
    expect(second.status).toBe('indexed');
    expect(second.chunks).toBe(first.chunks);
    const rows = await db
      .select({ n: schema.knowledgeChunk.id })
      .from(schema.knowledgeChunk)
      .where(eq(schema.knowledgeChunk.documentId, DOC_OK));
    expect(rows.length).toBe(first.chunks);
  });

  it('软删文档迟到 job → skipped（引用实时失效语义，11 §3.4）', async () => {
    const outcome = await processor.process(DOC_DELETED);
    expect(outcome.status).toBe('skipped');
    expect(outcome.error).toBe('deleted');
    const chunks = await db
      .select({ id: schema.knowledgeChunk.id })
      .from(schema.knowledgeChunk)
      .where(eq(schema.knowledgeChunk.documentId, DOC_DELETED));
    expect(chunks).toHaveLength(0);
  });

  it('文档不存在 → skipped(missing)', async () => {
    const outcome = await processor.process(createId('kdoc'));
    expect(outcome.status).toBe('skipped');
    expect(outcome.error).toBe('missing');
  });

  it('存储取文失败 → status=failed + error 留痕（11 retry 入口可见）', async () => {
    const outcome = await processor.process(DOC_BROKEN);
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toBeTruthy();
    const [doc] = await db
      .select({ status: schema.knowledgeDocument.status, error: schema.knowledgeDocument.error })
      .from(schema.knowledgeDocument)
      .where(eq(schema.knowledgeDocument.id, DOC_BROKEN));
    expect(doc?.status).toBe('failed');
    expect(doc?.error).toBeTruthy();
  });
});
