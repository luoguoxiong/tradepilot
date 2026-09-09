import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, ilike, isNull } from 'drizzle-orm';
import { BizException, createId, type SearchScene } from '@tradepilot/core';
import { schema, withOrg, type Db } from '@tradepilot/db';
import { TaskEnqueuer } from '@tradepilot/runtime';
import { getObjectStorage, knowledgeDocKey } from '@tradepilot/integrations';
import { searchKnowledgeChunks } from '@tradepilot/tools';
import { DB } from '../db/db.module.js';
import type { EnvService } from '../config/env.service.js';
import type {
  KnowledgeSearchDto,
  ListKnowledgeQuery,
  UploadKnowledgeDto,
} from './knowledge.dto.js';
import { KNOWLEDGE_FILE_TYPES, KNOWLEDGE_MAX_SIZE } from './knowledge.dto.js';

/**
 * 知识中心服务（接口 11 §3 / 技术方案 07 §2~§4）：
 * - 上传 = 全员；删除/重试 = 仅 manager/administrator（RolesGuard 控制在 controller 层）；
 * - 上传：白名单/大小/magic number 校验 → 对象存储存原文（kdoc/{orgId}/{docId}.{ext}）
 *   → knowledge_document(status='indexing') → 事务提交后入队 q:knowledge_index（07 §2）；
 * - 删除：软删留痕（deleted_at/deleted_by）+ 单事务 chunk 物理清除 → 检索实时失效（11 §3.4）；
 * - retry：仅 failed 可重试，retryCount+1，重跑流水线 ①起（11 §3.2）；
 * - search：复用 tools 混合检索（pgvector+tsquery+trgm+RRF+citations，07 §4）。
 */
@Injectable()
export class KnowledgeService {
  private readonly enqueuer: TaskEnqueuer;

  constructor(
    @Inject(DB) private readonly db: Db,
    env: EnvService,
  ) {
    this.enqueuer = new TaskEnqueuer(env.env.REDIS_URL);
  }

  /** 11 §3.1 上传（multipart：file + category + source） */
  async upload(
    orgId: string,
    userId: string,
    file: { originalname: string; size: number; buffer: Buffer },
    dto: UploadKnowledgeDto,
  ): Promise<{ docId: string; status: 'indexing' }> {
    const ext = file.originalname.toLowerCase().split('.').pop() ?? '';
    if (!KNOWLEDGE_FILE_TYPES.includes(ext as (typeof KNOWLEDGE_FILE_TYPES)[number])) {
      throw BizException.bizValidation(
        `不支持的文件格式: ${ext}（白名单 ${KNOWLEDGE_FILE_TYPES.join('/')}）`,
      );
    }
    if (file.size > KNOWLEDGE_MAX_SIZE) {
      throw BizException.bizValidation('文件大小超过 50MB 上限（11 §3.1）');
    }
    assertMagicNumber(ext, file.buffer);

    const docId = createId('kdoc');
    const objectKey = knowledgeDocKey(orgId, docId, ext);
    const contentType = ext === 'pdf' ? 'application/pdf' : 'application/octet-stream';
    const storage = getObjectStorage();
    try {
      await storage.putObject(objectKey, file.buffer, contentType);
    } catch {
      // 首次上传桶可能不存在：ensureBucket 后重试一次（MinIO 本地环境自举）
      await storage.ensureBucket();
      await storage.putObject(objectKey, file.buffer, contentType);
    }

    await withOrg(this.db, orgId, async (tx) => {
      await tx.insert(schema.knowledgeDocument).values({
        id: docId,
        orgId,
        fileName: file.originalname,
        category: dto.category,
        fileType: ext,
        size: file.size,
        fileUrl: objectKey,
        status: 'indexing',
        source: dto.source,
        uploadedBy: userId,
      });
    });
    // 事务提交后入队（Worker probe 必须读到已提交行，M3-01 同源教训）
    await this.enqueuer.enqueueKnowledgeIndex(docId);
    return { docId, status: 'indexing' };
  }

  /** 11 §2 文档列表（category/keyword；过滤已删） */
  async list(
    orgId: string,
    query: ListKnowledgeQuery & { page: number; pageSize: number },
  ): Promise<{
    items: {
      docId: string;
      fileName: string;
      category: string;
      status: string;
      error: string | null;
      size: number | null;
      fileType: string | null;
      uploadedAt: string;
      uploadedBy: string | null;
    }[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    return withOrg(this.db, orgId, async (tx) => {
      const conds = [
        eq(schema.knowledgeDocument.orgId, orgId),
        isNull(schema.knowledgeDocument.deletedAt),
      ];
      if (query.category) {
        conds.push(eq(schema.knowledgeDocument.category, query.category));
      }
      if (query.keyword) {
        conds.push(ilike(schema.knowledgeDocument.fileName, `%${query.keyword}%`));
      }
      const where = and(...conds);
      const rows = await tx
        .select({
          id: schema.knowledgeDocument.id,
          fileName: schema.knowledgeDocument.fileName,
          category: schema.knowledgeDocument.category,
          status: schema.knowledgeDocument.status,
          error: schema.knowledgeDocument.error,
          size: schema.knowledgeDocument.size,
          fileType: schema.knowledgeDocument.fileType,
          createdAt: schema.knowledgeDocument.createdAt,
          uploadedBy: schema.knowledgeDocument.uploadedBy,
        })
        .from(schema.knowledgeDocument)
        .where(where)
        .orderBy(desc(schema.knowledgeDocument.createdAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);
      const [total] = await tx.select({ n: count() }).from(schema.knowledgeDocument).where(where);
      return {
        items: rows.map((r) => ({
          docId: r.id,
          fileName: r.fileName,
          category: r.category,
          status: r.status,
          error: r.error,
          size: r.size,
          fileType: r.fileType,
          uploadedAt: r.createdAt.toISOString(),
          uploadedBy: r.uploadedBy,
        })),
        total: Number(total?.n ?? 0),
        page: query.page,
        pageSize: query.pageSize,
      };
    });
  }

  /** 11 §3.5 引用解析（单文档；含软删留痕回溯，不受已删过滤约束） */
  async detail(orgId: string, docId: string) {
    return withOrg(this.db, orgId, async (tx) => {
      const [doc] = await tx
        .select({
          id: schema.knowledgeDocument.id,
          fileName: schema.knowledgeDocument.fileName,
          category: schema.knowledgeDocument.category,
          status: schema.knowledgeDocument.status,
          createdAt: schema.knowledgeDocument.createdAt,
          uploadedBy: schema.knowledgeDocument.uploadedBy,
          deletedAt: schema.knowledgeDocument.deletedAt,
          deletedBy: schema.knowledgeDocument.deletedBy,
        })
        .from(schema.knowledgeDocument)
        .where(
          and(eq(schema.knowledgeDocument.id, docId), eq(schema.knowledgeDocument.orgId, orgId)),
        )
        .limit(1);
      if (!doc) {
        throw BizException.notFound(`知识文档不存在: ${docId}`);
      }
      const [uploader] = doc.uploadedBy
        ? await tx
            .select({ name: schema.userAccount.name })
            .from(schema.userAccount)
            .where(eq(schema.userAccount.id, doc.uploadedBy))
            .limit(1)
        : [];
      const [deleter] = doc.deletedBy
        ? await tx
            .select({ name: schema.userAccount.name })
            .from(schema.userAccount)
            .where(eq(schema.userAccount.id, doc.deletedBy))
            .limit(1)
        : [];
      return {
        docId: doc.id,
        fileName: doc.fileName,
        category: doc.category,
        status: doc.status,
        uploadedAt: doc.createdAt.toISOString(),
        updatedBy: uploader?.name ?? null,
        deleted: doc.deletedAt !== null,
        ...(doc.deletedAt ? { deletedAt: doc.deletedAt.toISOString() } : {}),
        ...(doc.deletedAt ? { deletedBy: deleter?.name ?? null } : {}),
      };
    });
  }

  /** 11 §3.4 删除（软删留痕 + chunk 物理清除，单事务；仅 manager/administrator） */
  async remove(orgId: string, userId: string, docId: string): Promise<{ deleted: boolean }> {
    await withOrg(this.db, orgId, async (tx) => {
      const [doc] = await tx
        .select({ id: schema.knowledgeDocument.id, deletedAt: schema.knowledgeDocument.deletedAt })
        .from(schema.knowledgeDocument)
        .where(
          and(eq(schema.knowledgeDocument.id, docId), eq(schema.knowledgeDocument.orgId, orgId)),
        )
        .limit(1);
      if (!doc) {
        throw BizException.notFound(`知识文档不存在: ${docId}`);
      }
      if (doc.deletedAt) {
        throw BizException.conflict('文档已删除（幂等拒绝重复删除）');
      }
      const now = new Date();
      // 软删留痕（行保留供引用回溯）+ 分块与向量随删动物理清除（检索天然不可命中）
      await tx
        .update(schema.knowledgeDocument)
        .set({ deletedAt: now, deletedBy: userId, updatedAt: now })
        .where(eq(schema.knowledgeDocument.id, docId));
      await tx.delete(schema.knowledgeChunk).where(eq(schema.knowledgeChunk.documentId, docId));
    });
    return { deleted: true };
  }

  /** 11 §3.2 失败重试索引（仅 failed 可重试；仅 manager/administrator） */
  async retry(orgId: string, docId: string): Promise<{ status: 'indexing' }> {
    const queued = await withOrg(this.db, orgId, async (tx) => {
      const [doc] = await tx
        .select({
          id: schema.knowledgeDocument.id,
          status: schema.knowledgeDocument.status,
          retryCount: schema.knowledgeDocument.retryCount,
          source: schema.knowledgeDocument.source,
        })
        .from(schema.knowledgeDocument)
        .where(
          and(eq(schema.knowledgeDocument.id, docId), eq(schema.knowledgeDocument.orgId, orgId)),
        )
        .limit(1);
      if (!doc) {
        throw BizException.notFound(`知识文档不存在: ${docId}`);
      }
      if (doc.status !== 'failed') {
        throw BizException.conflict(`仅索引失败文档可重试（当前状态: ${doc.status}）`);
      }
      await tx
        .update(schema.knowledgeDocument)
        .set({
          status: 'indexing',
          error: null,
          retryCount: doc.retryCount + 1,
          updatedAt: new Date(),
        })
        .where(eq(schema.knowledgeDocument.id, docId));
      return true;
    });
    if (queued) {
      await this.enqueuer.enqueueKnowledgeIndex(docId);
    }
    return { status: 'indexing' };
  }

  /** 11 §1.2 知识统计（Documents/Chunks/Last Updated，实时聚合 FR-05） */
  async stats(orgId: string): Promise<{
    documentsCount: number;
    chunksCount: number;
    lastIndexedAt: string | null;
  }> {
    return withOrg(this.db, orgId, async (tx) => {
      const [docs] = await tx
        .select({ n: count() })
        .from(schema.knowledgeDocument)
        .where(
          and(
            eq(schema.knowledgeDocument.orgId, orgId),
            isNull(schema.knowledgeDocument.deletedAt),
          ),
        );
      const [chunks] = await tx
        .select({ n: count() })
        .from(schema.knowledgeChunk)
        .where(eq(schema.knowledgeChunk.orgId, orgId));
      const [last] = await tx
        .select({ indexedAt: schema.knowledgeDocument.indexedAt })
        .from(schema.knowledgeDocument)
        .where(
          and(
            eq(schema.knowledgeDocument.orgId, orgId),
            isNull(schema.knowledgeDocument.deletedAt),
          ),
        )
        .orderBy(desc(schema.knowledgeDocument.indexedAt))
        .limit(1);
      return {
        documentsCount: Number(docs?.n ?? 0),
        chunksCount: Number(chunks?.n ?? 0),
        lastIndexedAt: last?.indexedAt?.toISOString() ?? null,
      };
    });
  }

  /** 11 §3.3 RAG 检索（对内 API，与 AI 工具共用混合检索实现 07 §4） */
  async search(orgId: string, dto: KnowledgeSearchDto) {
    return withOrg(this.db, orgId, async (tx) => {
      const { results, noResult } = await searchKnowledgeChunks(tx, orgId, {
        query: dto.query,
        scene: (dto.scene ?? null) as SearchScene | null,
        topK: dto.topK,
        categories: dto.category,
      });
      return {
        results: results.map((r) => ({
          docId: r.docId,
          docName: r.docName,
          chunkId: r.chunkId,
          content: r.content,
          score: Number(r.score.toFixed(4)),
          category: r.category,
        })),
        noResult,
      };
    });
  }
}

// ===== 模块级辅助 =====

/** magic number 复核（07 §2 / 08 §7：防伪装扩展名） */
function assertMagicNumber(ext: string, buffer: Buffer): void {
  if (ext === 'pdf') {
    if (buffer.subarray(0, 4).toString('ascii') !== '%PDF') {
      throw BizException.bizValidation('文件内容与 .pdf 扩展名不符（magic number 校验失败）');
    }
    return;
  }
  if (ext === 'docx') {
    // docx = zip 容器：PK\x03\x04
    if (buffer.subarray(0, 4).toString('hex') !== '504b0304') {
      throw BizException.bizValidation('文件内容与 .docx 扩展名不符（magic number 校验失败）');
    }
    return;
  }
  // md/txt：UTF-8 可解码性粗校验（含 BOM 容忍）
  if (buffer.subarray(0, 3).toString('hex') === 'efbbbf') {
    return;
  }
  const text = buffer.subarray(0, 4096).toString('utf8');
  if (text.includes('\uFFFD')) {
    throw BizException.bizValidation('文件内容不是有效文本（.md/.txt 校验失败）');
  }
}
