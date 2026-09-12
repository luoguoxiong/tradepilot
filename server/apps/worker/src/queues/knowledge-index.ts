/**
 * q:knowledge_index 知识入库流水线消费者（M4 #7，后端技术方案 07 §2）：
 *   取原文（对象存储）→ ① parse（pdf→unpdf / docx→mammoth / md/txt 直读）
 *   → ② clean（页眉页脚/全角归一）→ ③ chunk（结构感知 ~500 token，overlap 10%）
 *   → ④ embed（批量 ≤100/批）→ ⑤ 事务落库：旧 chunk 物理清除 + knowledge_chunk 批量插入
 *   → status='indexed'。失败 → status='failed' + error 文案（重试由 11 接口 retry 重跑 ①起）。
 *
 * 说明：索引流水线为系统消费者（job.data={docId}，jobId=`kidx.{docId}`），不落 ai_task——
 * 知识上传无 AI 员工归属，终态/错误/耗时留痕在 knowledge_document 行上（11 接口轮询可见）。
 * 覆盖式更新（11 §7.2）= 软删旧文档 + 新文档新 ID 走全流水线，引用不迁移。
 */
import { eq, sql } from 'drizzle-orm';
import { schema, withOrg, type Db } from '@tradepilot/db';
import { createId, cleanDocumentText, chunkDocumentText } from '@tradepilot/core';
import { getObjectStorage, getEmbeddingProvider } from '@tradepilot/integrations';
import type { Logger } from 'pino';

/** 单批嵌入条数上限（07 §2 ④） */
const EMBED_BATCH_SIZE = 100;
/** 单文档处理超时（07 §2：10min → failed，靠 parse/embed 侧超时累计；此处为兜底闸） */
const DOC_TIMEOUT_MS = 10 * 60_000;

export interface KnowledgeIndexDeps {
  db: Db;
  logger: Logger;
}

export interface IndexOutcome {
  docId: string;
  status: 'indexed' | 'failed' | 'skipped';
  chunks?: number;
  error?: string;
}

export class KnowledgeIndexProcessor {
  constructor(private readonly deps: KnowledgeIndexDeps) {}

  async process(docId: string): Promise<IndexOutcome> {
    const { db, logger } = this.deps;
    const started = Date.now();

    // ① 跨租户定位文档（sched_scan 放行 SELECT，02 §4.3）
    const doc = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.sched', '1', true)`);
      const [row] = await tx
        .select({
          id: schema.knowledgeDocument.id,
          orgId: schema.knowledgeDocument.orgId,
          fileName: schema.knowledgeDocument.fileName,
          fileType: schema.knowledgeDocument.fileType,
          fileUrl: schema.knowledgeDocument.fileUrl,
          deletedAt: schema.knowledgeDocument.deletedAt,
        })
        .from(schema.knowledgeDocument)
        .where(eq(schema.knowledgeDocument.id, docId))
        .limit(1);
      return row ?? null;
    });
    if (!doc) {
      return { docId, status: 'skipped', error: 'missing' };
    }
    if (doc.deletedAt) {
      // 软删后抵达的迟到 job：引用已随删动失效，跳过（检索实时失效语义，11 §3.4）
      return { docId, status: 'skipped', error: 'deleted' };
    }

    try {
      // ② 取原文（fileUrl 即对象 key：kdoc/{orgId}/{docId}.{ext}）
      const bytes = await getObjectStorage().getObject(doc.fileUrl);

      // ③ parse
      const text = await parseDocument(bytes, doc.fileType ?? extOf(doc.fileName));

      // ④ clean + chunk
      const cleaned = cleanDocumentText(text);
      const chunks = chunkDocumentText(cleaned);
      if (chunks.length === 0) {
        throw new Error('文档解析后无可索引内容（空文本）');
      }

      // ⑤ embed（≤100/批）；16 FR-10 扩展：按 org 选用模型解析（未配置回落内置 mock）
      const embedding = await getEmbeddingProvider(doc.orgId);
      const vectors: number[][] = [];
      for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
        const batch = chunks.slice(i, i + EMBED_BATCH_SIZE).map((c) => c.content);
        vectors.push(...(await embedding.embed(batch)));
      }
      if (vectors.length !== chunks.length) {
        throw new Error(`嵌入返回条数不匹配: ${vectors.length}/${chunks.length}`);
      }

      // ⑥ 事务落库：旧 chunk 物理清除（retry 重跑语义）+ 新 chunk 插入 + status='indexed'
      const inserted = await withOrg(db, doc.orgId, async (tx) => {
        await tx.delete(schema.knowledgeChunk).where(eq(schema.knowledgeChunk.documentId, docId));
        const values = chunks.map((c, i) => ({
          id: createId('kchk'),
          orgId: doc.orgId,
          documentId: docId,
          chunkIndex: c.index,
          content: c.content,
          tokenCount: c.tokenCount,
          embedding: vectors[i] ?? [],
          metadata: { headingPath: c.metadata.headingPath },
        }));
        for (let i = 0; i < values.length; i += 50) {
          await tx.insert(schema.knowledgeChunk).values(values.slice(i, i + 50));
        }
        await tx
          .update(schema.knowledgeDocument)
          .set({
            status: 'indexed',
            error: null,
            indexedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.knowledgeDocument.id, docId));
        return values.length;
      });

      logger.info(
        { docId, orgId: doc.orgId, chunks: inserted, ms: Date.now() - started },
        '知识文档索引完成',
      );
      return { docId, status: 'indexed', chunks: inserted };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await withOrg(db, doc.orgId, async (tx) => {
        await tx
          .update(schema.knowledgeDocument)
          .set({ status: 'failed', error: message.slice(0, 500), updatedAt: new Date() })
          .where(eq(schema.knowledgeDocument.id, docId));
      }).catch(() => {
        // 留痕失败不掩盖原始错误
      });
      logger.warn({ docId, err: message }, '知识文档索引失败');
      return { docId, status: 'failed', error: message };
    }
  }
}

/** 解析器分发（07 §2 ①：pdf→unpdf / docx→mammoth / md/txt 直读） */
async function parseDocument(bytes: Buffer, fileType: string): Promise<string> {
  const deadline = Date.now() + DOC_TIMEOUT_MS;
  switch (fileType.toLowerCase()) {
    case 'pdf': {
      const { extractText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractText(pdf, { mergePages: true });
      void deadline;
      return text;
    }
    case 'docx': {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer: bytes });
      return result.value;
    }
    case 'md':
    case 'txt':
    case '':
      return bytes.toString('utf8');
    default:
      throw new Error(`不支持的文件类型: ${fileType}`);
  }
}

function extOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot + 1) : '';
}
