import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { BizException, createId } from '@tradepilot/core';
import { schema, withOrg, type Db, type Tx } from '@tradepilot/db';
import { TaskEnqueuer } from '@tradepilot/runtime';
import { getObjectStorage } from '@tradepilot/integrations';
import { DB } from '../db/db.module.js';
import { EnvService } from '../config/env.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import {
  PRODUCT_FILE_TYPES,
  PRODUCT_MAX_FILE_SIZE,
  type CreateProductDto,
  type ListProductsQuery,
  type ProductKnowledgeRequestDto,
  type UpdateProductDto,
  type UploadProductDocumentDto,
} from './products.dto.js';

/** AI 员工回退顺序（08 §3.2：产品知识优先跟单/研究员，退到任意空闲员工） */
const PRODUCT_EMPLOYEE_ROLE_PREFERENCE = ['merchandiser', 'customer_researcher', 'sales'] as const;

/**
 * 产品中心服务（接口 08 §2/§3 / 需求 08 §4）：
 * - 读：列表（keyword/category/status）+ 详情（5 页签字段）；
 * - 写：新增/编辑（SKU 同企业唯一 → 42201；规格/阶梯价整体替换）；
 * - 资料：上传（对象存储）→ 归档 knowledge_document(source='product', category='product') 并回写
 *   product_document.knowledge_doc_id + 入队索引（§4：自动归档知识中心「产品」分类）；
 * - AI：analyze（仅预览不落库）/ generate（落 product_knowledge status=draft）→ 统一投
 *   `product_knowledge` 任务（与 M5-C4 客户分析 product_analysis 分离）；
 * - confirm：draft → approved（人工确认后 AI 销售/报价场景可见）；
 * - 红线：costPrice 只进结构化 Pricing，绝不进 AI prompt（prompt 层 stripSensitiveFields 双保险，§7）。
 */
@Injectable()
export class ProductsService {
  private readonly enqueuer: TaskEnqueuer;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(EnvService) env: EnvService,
    @Inject(TasksService) private readonly tasks: TasksService,
  ) {
    this.enqueuer = new TaskEnqueuer(env.env.REDIS_URL);
  }

  // ===== 列表 / 详情 =====

  /** 08 §1.1/§2 产品列表（keyword=名称/SKU 模糊，category/status 精确） */
  async list(
    orgId: string,
    query: ListProductsQuery & { page: number; pageSize: number; keyword?: string },
  ): Promise<{
    items: {
      productId: string;
      sku: string;
      name: string;
      image: string | null;
      moq: number;
      moqUnit: string;
      status: string;
      category: string | null;
    }[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    return withOrg(this.db, orgId, async (tx) => {
      const conds = [eq(schema.product.orgId, orgId)];
      if (query.category) {
        conds.push(eq(schema.product.category, query.category));
      }
      if (query.status) {
        conds.push(eq(schema.product.status, query.status));
      }
      if (query.keyword) {
        const like = `%${query.keyword}%`;
        conds.push(or(ilike(schema.product.name, like), ilike(schema.product.sku, like))!);
      }
      const where = and(...conds);
      const rows = await tx
        .select({
          id: schema.product.id,
          sku: schema.product.sku,
          name: schema.product.name,
          imageUrl: schema.product.imageUrl,
          moq: schema.product.moq,
          moqUnit: schema.product.moqUnit,
          status: schema.product.status,
          category: schema.product.category,
        })
        .from(schema.product)
        .where(where)
        .orderBy(desc(schema.product.createdAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);
      const [total] = await tx.select({ n: count() }).from(schema.product).where(where);
      return {
        items: rows.map((r) => ({
          productId: r.id,
          sku: r.sku,
          name: r.name,
          image: r.imageUrl ?? null,
          moq: r.moq,
          moqUnit: r.moqUnit,
          status: r.status,
          category: r.category ?? null,
        })),
        total: Number(total?.n ?? 0),
        page: query.page,
        pageSize: query.pageSize,
      };
    });
  }

  /** 08 §1.2~§1.6 详情（Overview/Specifications/Pricing/Documents/AI Knowledge 全字段） */
  async detail(orgId: string, productId: string) {
    return withOrg(this.db, orgId, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.product)
        .where(and(eq(schema.product.id, productId), eq(schema.product.orgId, orgId)))
        .limit(1);
      if (!row) {
        throw BizException.notFound(`产品不存在: ${productId}`);
      }
      const specs = await tx
        .select({
          name: schema.productSpec.name,
          value: schema.productSpec.value,
          unit: schema.productSpec.unit,
        })
        .from(schema.productSpec)
        .where(eq(schema.productSpec.productId, productId))
        .orderBy(asc(schema.productSpec.seq));
      const tiers = await tx
        .select({
          minQty: schema.productPriceTier.minQty,
          unitPrice: schema.productPriceTier.unitPrice,
        })
        .from(schema.productPriceTier)
        .where(eq(schema.productPriceTier.productId, productId))
        .orderBy(asc(schema.productPriceTier.minQty));
      const docs = await tx
        .select({
          id: schema.productDocument.id,
          fileName: schema.productDocument.fileName,
          docType: schema.productDocument.docType,
          size: schema.productDocument.size,
          indexed: schema.productDocument.indexed,
          createdAt: schema.productDocument.createdAt,
        })
        .from(schema.productDocument)
        .where(
          and(
            eq(schema.productDocument.orgId, orgId),
            eq(schema.productDocument.productId, productId),
          ),
        )
        .orderBy(desc(schema.productDocument.createdAt));
      const [knowledge] = await tx
        .select()
        .from(schema.productKnowledge)
        .where(
          and(
            eq(schema.productKnowledge.orgId, orgId),
            eq(schema.productKnowledge.productId, productId),
          ),
        )
        .limit(1);
      const confirmer = knowledge?.confirmedBy
        ? await tx
            .select({ name: schema.userAccount.name })
            .from(schema.userAccount)
            .where(eq(schema.userAccount.id, knowledge.confirmedBy))
            .limit(1)
        : [];

      return {
        productId: row.id,
        sku: row.sku,
        name: row.name,
        category: row.category ?? null,
        image: row.imageUrl ?? null,
        moq: row.moq,
        moqUnit: row.moqUnit,
        leadTimeDays: row.leadTimeDays,
        material: row.material ?? null,
        description: row.description ?? null,
        // Pricing（结构化字段；AI 不改价，08 §4）
        costPrice: row.costPrice,
        currency: row.currency,
        suggestedPrice: row.suggestedPrice ?? null,
        status: row.status,
        specifications: specs.map((s) => ({
          name: s.name,
          value: s.value,
          ...(s.unit ? { unit: s.unit } : {}),
        })),
        priceTiers: tiers.map((t) => ({ minQty: t.minQty, unitPrice: t.unitPrice })),
        documents: docs.map((d) => ({
          fileId: d.id,
          fileName: d.fileName,
          docType: d.docType,
          size: formatFileSize(d.size),
          uploadedAt: d.createdAt.toISOString(),
          indexed: d.indexed,
        })),
        knowledge: knowledge
          ? {
              advantages: knowledge.advantages ?? [],
              faqs: knowledge.faqs ?? [],
              scenarios: knowledge.scenarios ?? [],
              salesScripts: knowledge.salesScripts ?? [],
              status: knowledge.status,
              citations: knowledge.citations ?? [],
              generatedAt: knowledge.generatedAt?.toISOString() ?? null,
              confirmedBy: confirmer[0]?.name ?? null,
              confirmedAt: knowledge.confirmedAt?.toISOString() ?? null,
            }
          : null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  // ===== 新增 / 编辑 =====

  /** 08 §3.1 新增产品（SKU 同企业唯一 → 42201；保存后归档资料） */
  async create(
    orgId: string,
    userId: string,
    dto: CreateProductDto,
  ): Promise<{ productId: string }> {
    const productId = createId('prod');
    const now = new Date();
    await withOrg(this.db, orgId, async (tx) => {
      await assertSkuUnique(tx, orgId, dto.sku);
      await tx.insert(schema.product).values({
        id: productId,
        orgId,
        sku: dto.sku,
        name: dto.name,
        category: dto.category ?? null,
        imageUrl: dto.image ?? null,
        moq: dto.moq,
        moqUnit: dto.moqUnit,
        leadTimeDays: dto.leadTimeDays,
        material: dto.material ?? null,
        description: dto.description ?? null,
        costPrice: dto.costPrice,
        currency: dto.currency,
        suggestedPrice: dto.suggestedPrice ?? null,
        status: dto.status,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });
      await replaceSpecs(tx, productId, dto.specifications);
      await replaceTiers(tx, productId, dto.priceTiers);
    });
    // 保存后触发知识中心归档（无资料时为空操作；幂等，仅归档未归档项）
    await this.archivePendingDocuments(orgId, userId, productId);
    return { productId };
  }

  /** 08 §3.3 编辑产品（字段可选；SKU 变更仍校验唯一） */
  async update(
    orgId: string,
    userId: string,
    productId: string,
    dto: UpdateProductDto,
  ): Promise<{ productId: string }> {
    const now = new Date();
    await withOrg(this.db, orgId, async (tx) => {
      const [row] = await tx
        .select({ id: schema.product.id, sku: schema.product.sku })
        .from(schema.product)
        .where(and(eq(schema.product.id, productId), eq(schema.product.orgId, orgId)))
        .limit(1);
      if (!row) {
        throw BizException.notFound(`产品不存在: ${productId}`);
      }
      if (dto.sku && dto.sku !== row.sku) {
        await assertSkuUnique(tx, orgId, dto.sku);
      }
      await tx
        .update(schema.product)
        .set({
          ...(dto.sku !== undefined ? { sku: dto.sku } : {}),
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.category !== undefined ? { category: dto.category } : {}),
          ...(dto.image !== undefined ? { imageUrl: dto.image } : {}),
          ...(dto.moq !== undefined ? { moq: dto.moq } : {}),
          ...(dto.moqUnit !== undefined ? { moqUnit: dto.moqUnit } : {}),
          ...(dto.leadTimeDays !== undefined ? { leadTimeDays: dto.leadTimeDays } : {}),
          ...(dto.material !== undefined ? { material: dto.material } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.costPrice !== undefined ? { costPrice: dto.costPrice } : {}),
          ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
          ...(dto.suggestedPrice !== undefined ? { suggestedPrice: dto.suggestedPrice } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          updatedAt: now,
        })
        .where(eq(schema.product.id, productId));
      if (dto.specifications !== undefined) {
        await tx.delete(schema.productSpec).where(eq(schema.productSpec.productId, productId));
        await replaceSpecs(tx, productId, dto.specifications);
      }
      if (dto.priceTiers !== undefined) {
        await tx
          .delete(schema.productPriceTier)
          .where(eq(schema.productPriceTier.productId, productId));
        await replaceTiers(tx, productId, dto.priceTiers);
      }
    });
    await this.archivePendingDocuments(orgId, userId, productId);
    return { productId };
  }

  // ===== 资料上传 / 删除 + 归档 =====

  /** 08 §1.5/§4 上传产品资料（对象存储 → product_document → 归档知识中心并索引） */
  async uploadDocument(
    orgId: string,
    userId: string,
    productId: string,
    file: { originalname: string; size: number; buffer: Buffer },
    dto: UploadProductDocumentDto,
  ): Promise<{ fileId: string; indexed: boolean }> {
    await this.assertProductExists(orgId, productId);
    const ext = file.originalname.toLowerCase().split('.').pop() ?? '';
    if (!PRODUCT_FILE_TYPES.includes(ext as (typeof PRODUCT_FILE_TYPES)[number])) {
      throw BizException.bizValidation(
        `不支持的文件格式: ${ext}（白名单 ${PRODUCT_FILE_TYPES.join('/')}）`,
      );
    }
    if (file.size > PRODUCT_MAX_FILE_SIZE) {
      throw BizException.bizValidation('文件大小超过 50MB 上限（08 §1.5）');
    }
    assertMagicNumber(ext, file.buffer);

    const fileId = createId('pdoc');
    const objectKey = productDocKey(orgId, fileId, ext);
    const contentType = ext === 'pdf' ? 'application/pdf' : 'application/octet-stream';
    const storage = getObjectStorage();
    try {
      await storage.putObject(objectKey, file.buffer, contentType);
    } catch {
      // 首次上传桶可能不存在：ensureBucket 后重试一次（MinIO 本地环境自举，同知识中心）
      await storage.ensureBucket();
      await storage.putObject(objectKey, file.buffer, contentType);
    }

    await withOrg(this.db, orgId, async (tx) => {
      await tx.insert(schema.productDocument).values({
        id: fileId,
        orgId,
        productId,
        fileName: file.originalname,
        fileUrl: objectKey,
        size: file.size,
        docType: dto.docType,
        indexed: false,
        uploadedBy: userId,
      });
    });
    await this.archivePendingDocuments(orgId, userId, productId);
    return { fileId, indexed: false };
  }

  /** 08 §2 删除产品资料（物理删 product_document + 软删知识文档并清除 chunk，检索实时失效） */
  async removeDocument(
    orgId: string,
    userId: string,
    productId: string,
    fileId: string,
  ): Promise<{ deleted: boolean }> {
    await withOrg(this.db, orgId, async (tx) => {
      const [row] = await tx
        .select({
          id: schema.productDocument.id,
          knowledgeDocId: schema.productDocument.knowledgeDocId,
        })
        .from(schema.productDocument)
        .where(
          and(
            eq(schema.productDocument.id, fileId),
            eq(schema.productDocument.orgId, orgId),
            eq(schema.productDocument.productId, productId),
          ),
        )
        .limit(1);
      if (!row) {
        throw BizException.notFound(`产品资料不存在: ${fileId}`);
      }
      const now = new Date();
      await tx.delete(schema.productDocument).where(eq(schema.productDocument.id, fileId));
      if (row.knowledgeDocId) {
        await tx
          .update(schema.knowledgeDocument)
          .set({ deletedAt: now, deletedBy: userId, updatedAt: now })
          .where(eq(schema.knowledgeDocument.id, row.knowledgeDocId));
        await tx
          .delete(schema.knowledgeChunk)
          .where(eq(schema.knowledgeChunk.documentId, row.knowledgeDocId));
      }
    });
    return { deleted: true };
  }

  /**
   * 归档待索引产品资料（08 §4：自动归档知识中心「产品」分类并建索引）：
   * 对未归档的 product_document 建 knowledge_document(source='product', category='product')，
   * 回写 product_document.knowledge_doc_id，事务提交后逐条入队索引。
   */
  private async archivePendingDocuments(
    orgId: string,
    userId: string,
    productId: string,
  ): Promise<string[]> {
    const enqueued: string[] = [];
    await withOrg(this.db, orgId, async (tx) => {
      const pending = await tx
        .select({
          id: schema.productDocument.id,
          fileName: schema.productDocument.fileName,
          fileUrl: schema.productDocument.fileUrl,
          size: schema.productDocument.size,
        })
        .from(schema.productDocument)
        .where(
          and(
            eq(schema.productDocument.orgId, orgId),
            eq(schema.productDocument.productId, productId),
            isNull(schema.productDocument.knowledgeDocId),
          ),
        );
      const now = new Date();
      for (const doc of pending) {
        const docId = createId('doc');
        const ext = doc.fileName.toLowerCase().split('.').pop() ?? '';
        await tx.insert(schema.knowledgeDocument).values({
          id: docId,
          orgId,
          fileName: doc.fileName,
          category: 'product',
          fileType: ext || null,
          size: doc.size,
          fileUrl: doc.fileUrl,
          status: 'indexing',
          source: 'product',
          productId,
          uploadedBy: userId,
        });
        await tx
          .update(schema.productDocument)
          .set({ knowledgeDocId: docId, indexed: false, updatedAt: now })
          .where(eq(schema.productDocument.id, doc.id));
        enqueued.push(docId);
      }
    });
    for (const docId of enqueued) {
      await this.enqueuer.enqueueKnowledgeIndex(docId);
    }
    return enqueued;
  }

  // ===== AI 分析 / 生成 / 确认 =====

  /** 08 §3.3 AI 分析产品（预览，不落库、不改产品基础字段） */
  async analyze(
    orgId: string,
    userId: string,
    productId: string,
    dto: ProductKnowledgeRequestDto,
  ): Promise<{ taskId: string }> {
    return this.enqueueKnowledgeTask(orgId, userId, productId, dto, 'analyze');
  }

  /** 08 §3.2 AI 生成知识（落 product_knowledge status=draft，待人工确认） */
  async generateKnowledge(
    orgId: string,
    userId: string,
    productId: string,
    dto: ProductKnowledgeRequestDto,
  ): Promise<{ taskId: string }> {
    return this.enqueueKnowledgeTask(orgId, userId, productId, dto, 'generate');
  }

  /** 08 §3.2 人工确认启用（draft → approved，AI 销售/报价场景可见） */
  async confirmKnowledge(
    orgId: string,
    userId: string,
    productId: string,
  ): Promise<{ productId: string; status: string }> {
    return withOrg(this.db, orgId, async (tx) => {
      const [row] = await tx
        .select({ id: schema.productKnowledge.id, status: schema.productKnowledge.status })
        .from(schema.productKnowledge)
        .where(
          and(
            eq(schema.productKnowledge.orgId, orgId),
            eq(schema.productKnowledge.productId, productId),
          ),
        )
        .limit(1);
      if (!row) {
        throw BizException.notFound('产品知识尚未生成，无法确认（请先执行 AI 生成）');
      }
      if (row.status === 'approved') {
        return { productId, status: 'approved' }; // 幂等
      }
      const now = new Date();
      await tx
        .update(schema.productKnowledge)
        .set({ status: 'approved', confirmedBy: userId, confirmedAt: now, updatedAt: now })
        .where(eq(schema.productKnowledge.id, row.id));
      return { productId, status: 'approved' };
    });
  }

  /** 解析可用 AI 员工 + 投递 product_knowledge 任务（analyze | generate 同图不同写入分支） */
  private async enqueueKnowledgeTask(
    orgId: string,
    userId: string,
    productId: string,
    dto: ProductKnowledgeRequestDto,
    action: 'analyze' | 'generate',
  ): Promise<{ taskId: string }> {
    await this.assertProductExists(orgId, productId);
    const employeeId = await this.resolveProductEmployee(orgId);
    const created = await this.tasks.create(orgId, userId, {
      employeeId,
      type: 'product_knowledge',
      title: action === 'generate' ? `生成产品知识：${productId}` : `分析产品：${productId}`,
      input: { productId, sources: dto.sources, action },
    });
    return { taskId: created.taskId };
  }

  private async resolveProductEmployee(orgId: string): Promise<string> {
    return withOrg(this.db, orgId, async (tx) => {
      const [preferred] = await tx
        .select({ id: schema.aiEmployee.id })
        .from(schema.aiEmployee)
        .where(
          and(
            eq(schema.aiEmployee.orgId, orgId),
            inArray(schema.aiEmployee.role, [...PRODUCT_EMPLOYEE_ROLE_PREFERENCE]),
          ),
        )
        // 角色优先级：merchandiser(0) < customer_researcher(1) < sales(2)
        .orderBy(
          rolePreferenceOrder([...PRODUCT_EMPLOYEE_ROLE_PREFERENCE]),
          asc(schema.aiEmployee.createdAt),
        )
        .limit(1);
      if (preferred) {
        return preferred.id;
      }
      const [fallback] = await tx
        .select({ id: schema.aiEmployee.id })
        .from(schema.aiEmployee)
        .where(eq(schema.aiEmployee.orgId, orgId))
        .orderBy(asc(schema.aiEmployee.createdAt))
        .limit(1);
      if (!fallback) {
        throw BizException.notFound('未找到可用 AI 员工（08 §3.2）');
      }
      return fallback.id;
    });
  }

  private async assertProductExists(orgId: string, productId: string): Promise<void> {
    await withOrg(this.db, orgId, async (tx) => {
      const [row] = await tx
        .select({ id: schema.product.id })
        .from(schema.product)
        .where(and(eq(schema.product.id, productId), eq(schema.product.orgId, orgId)))
        .limit(1);
      if (!row) {
        throw BizException.notFound(`产品不存在: ${productId}`);
      }
    });
  }
}

// ===== 模块级辅助 =====

/** SKU 同企业唯一（08 §3.1：重复 → 42201；DB uq_product_org_sku 兜底） */
async function assertSkuUnique(tx: Tx, orgId: string, sku: string): Promise<void> {
  const [row] = await tx
    .select({ id: schema.product.id })
    .from(schema.product)
    .where(and(eq(schema.product.orgId, orgId), eq(schema.product.sku, sku)))
    .limit(1);
  if (row) {
    throw BizException.bizValidation(`SKU 已存在: ${sku}`);
  }
}

/** 规格整体替换（seq 从 1 连续，满足 uq_product_spec_seq） */
async function replaceSpecs(
  tx: Tx,
  productId: string,
  specs: { name: string; value: string; unit?: string }[],
): Promise<void> {
  if (specs.length === 0) {
    return;
  }
  await tx.insert(schema.productSpec).values(
    specs.map((s, index) => ({
      id: createId('pspec'),
      productId,
      seq: index + 1,
      name: s.name,
      value: s.value,
      unit: s.unit ?? null,
    })),
  );
}

/** 阶梯价整体替换（minQty 已在 DTO 去重，满足 uq_product_tier_min_qty） */
async function replaceTiers(
  tx: Tx,
  productId: string,
  tiers: { minQty: number; unitPrice: string }[],
): Promise<void> {
  if (tiers.length === 0) {
    return;
  }
  await tx.insert(schema.productPriceTier).values(
    tiers.map((t) => ({
      id: createId('ptier'),
      productId,
      minQty: t.minQty,
      unitPrice: t.unitPrice,
    })),
  );
}

/** 字节数 → 可读大小（对齐知识中心 11 §1.1） */
function formatFileSize(bytes: number | null): string | null {
  if (bytes === null || bytes === undefined) {
    return null;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

/** magic number 复核（防伪装扩展名；与知识中心 11 §3.1 同口径） */
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
  if (buffer.subarray(0, 3).toString('hex') === 'efbbbf') {
    return;
  }
  const text = buffer.subarray(0, 4096).toString('utf8');
  if (text.includes('\uFFFD')) {
    throw BizException.bizValidation('文件内容不是有效文本（.md/.txt 校验失败）');
  }
}

/** 产品资料对象 key（对象存储；与 knowledge_document.fileUrl 同值供索引直读） */
function productDocKey(orgId: string, fileId: string, ext: string): string {
  return `pdoc/${orgId}/${fileId}.${ext}`;
}

/** 角色优先级排序表达式（case when role=r0 then 0 ... else n end） */
function rolePreferenceOrder(roles: string[]) {
  const chunks = roles.map(
    (role, index) => sql`when ${schema.aiEmployee.role} = ${role} then ${index}`,
  );
  return sql`case ${sql.join(chunks, sql` `)} else ${roles.length} end`;
}
