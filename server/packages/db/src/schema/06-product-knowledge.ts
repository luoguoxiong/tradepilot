import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  vector,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { indexStatus, knowledgeCategory, productDocType, productStatus } from './enums.js';
import { org, userAccount } from './01-org-user.js';
import { aiTask } from './02-ai-task.js';

/**
 * ER 06 · 产品与知识模块（7 表）。
 * trgm gin / hnsw 向量索引由 manual 迁移交付（02 §2.2）。
 */

export const product = pgTable(
  'product',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    category: text('category'),
    imageUrl: text('image_url'),
    moq: integer('moq').notNull(),
    moqUnit: text('moq_unit').notNull().default('pcs'),
    leadTimeDays: smallint('lead_time_days').notNull(),
    material: text('material'),
    description: text('description'),
    /** 采购成本（定价引擎输入，AI 无改价接口；不进 AI 生成 prompt，08 §7） */
    costPrice: numeric('cost_price', { precision: 18, scale: 2 }).notNull(),
    currency: text('currency').notNull().default('USD'),
    suggestedPrice: numeric('suggested_price', { precision: 18, scale: 2 }),
    status: productStatus('status').notNull().default('draft'),
    createdBy: text('created_by').references(() => userAccount.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_product_org_sku').on(t.orgId, t.sku),
    index('idx_product_org_status').on(t.orgId, t.status),
    index('idx_product_org_category').on(t.orgId, t.category),
  ],
);

/** 规格：无 org_id 列（随 product 归属），RLS 不覆盖、查询必经 product（02 §4 边界） */
export const productSpec = pgTable(
  'product_spec',
  {
    id: text('id').primaryKey(),
    productId: text('product_id')
      .notNull()
      .references(() => product.id),
    seq: smallint('seq').notNull(),
    name: text('name').notNull(),
    value: text('value').notNull(),
    unit: text('unit'),
  },
  (t) => [unique('uq_product_spec_seq').on(t.productId, t.seq)],
);

export const productPriceTier = pgTable(
  'product_price_tier',
  {
    id: text('id').primaryKey(),
    productId: text('product_id')
      .notNull()
      .references(() => product.id),
    minQty: integer('min_qty').notNull(),
    unitPrice: numeric('unit_price', { precision: 18, scale: 4 }).notNull(),
  },
  (t) => [unique('uq_product_tier_min_qty').on(t.productId, t.minQty)],
);

export const productDocument = pgTable(
  'product_document',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    productId: text('product_id')
      .notNull()
      .references(() => product.id),
    fileName: text('file_name').notNull(),
    fileUrl: text('file_url').notNull(),
    size: bigint('size', { mode: 'number' }),
    docType: productDocType('doc_type').notNull(),
    indexed: boolean('indexed').notNull().default(false),
    knowledgeDocId: text('knowledge_doc_id').references((): AnyPgColumn => knowledgeDocument.id),
    uploadedBy: text('uploaded_by').references(() => userAccount.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_pdoc_product').on(t.productId)],
);

export const productKnowledge = pgTable(
  'product_knowledge',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    productId: text('product_id')
      .notNull()
      .references(() => product.id),
    advantages: text('advantages').array(),
    faqs: jsonb('faqs').$type<{ question: string; answer: string }[]>(),
    scenarios: text('scenarios').array(),
    salesScripts: text('sales_scripts').array(),
    status: text('status').notNull().default('draft'),
    citations: jsonb('citations').$type<{ docId: string; chunkId?: string }[]>(),
    taskId: text('task_id').references(() => aiTask.id),
    generatedAt: timestamp('generated_at', { withTimezone: true }),
    confirmedBy: text('confirmed_by').references(() => userAccount.id),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('uq_product_knowledge_product').on(t.productId)],
);

export const knowledgeDocument = pgTable(
  'knowledge_document',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    fileName: text('file_name').notNull(),
    category: knowledgeCategory('category').notNull(),
    fileType: text('file_type'),
    size: bigint('size', { mode: 'number' }),
    fileUrl: text('file_url').notNull(),
    status: indexStatus('status').notNull().default('indexing'),
    error: text('error'),
    retryCount: smallint('retry_count').notNull().default(0),
    source: text('source').notNull().default('upload'),
    productId: text('product_id').references(() => product.id),
    uploadedBy: text('uploaded_by').references(() => userAccount.id),
    indexedAt: timestamp('indexed_at', { withTimezone: true }),
    /** 软删留痕（11 §7.2）：行保留供引用回溯，chunk 随删动物理清除 */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: text('deleted_by').references(() => userAccount.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_kdoc_org_category').on(t.orgId, t.category),
    index('idx_kdoc_org_status').on(t.orgId, t.status),
  ],
);

export const knowledgeChunk = pgTable(
  'knowledge_chunk',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    documentId: text('document_id')
      .notNull()
      .references(() => knowledgeDocument.id),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    tokenCount: integer('token_count'),
    embedding: vector('embedding', { dimensions: 1536 }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_kchunk_doc_index').on(t.documentId, t.chunkIndex),
    index('idx_kchunk_doc').on(t.documentId),
  ],
);
