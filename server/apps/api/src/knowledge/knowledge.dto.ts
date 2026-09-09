import { z } from 'zod';

/**
 * 知识中心契约（接口 11 §3，P0）：
 * documents 上传（multipart）/列表/详情（软删回溯）/软删/retry/stats/search。
 * 权限：检索/引用 org 级全量共享（全员）；上传 = 全员；删除/重试 = 仅 manager/administrator（11 §7.3）。
 */

/** 格式白名单（11 §3.1：pdf/docx/md/txt，≤50MB 超限 42201） */
export const KNOWLEDGE_FILE_TYPES = ['pdf', 'docx', 'md', 'txt'] as const;
export const KNOWLEDGE_MAX_SIZE = 50 * 1024 * 1024;

export const knowledgeCategorySchema = z.enum([
  'product',
  'company',
  'sales',
  'customer',
  'faq',
  'process',
  'other',
]);

export const uploadKnowledgeSchema = z.object({
  category: knowledgeCategorySchema,
  /** 入库来源（11 §3.1：upload / email_attachment；product 仅由 08 归档内部写入） */
  source: z.enum(['upload', 'email_attachment']).default('upload'),
});
export type UploadKnowledgeDto = z.infer<typeof uploadKnowledgeSchema>;

export const listKnowledgeQuerySchema = z.object({
  category: knowledgeCategorySchema.optional(),
  keyword: z.string().trim().max(100).optional(),
});
export type ListKnowledgeQuery = z.infer<typeof listKnowledgeQuerySchema>;

export const knowledgeSearchSchema = z.object({
  query: z.string().trim().min(1, 'query 不能为空').max(500),
  category: z.array(knowledgeCategorySchema).optional(),
  topK: z.number().int().min(1).max(20).default(5),
  scene: z
    .enum(['lead_match', 'sales_reply', 'follow_up', 'pricing_basis', 'business_analysis'])
    .optional(),
});
export type KnowledgeSearchDto = z.infer<typeof knowledgeSearchSchema>;
