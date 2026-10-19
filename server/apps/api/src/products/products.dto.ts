/**
 * 08 产品中心 DTO（页面级接口文档 08 §1/§3，P1）：
 * - 列表（keyword/category/status）→ §2；新增（响应 { productId }，SKU 同企业唯一 → 42201）；
 * - 详情含 5 页签字段（Overview/Specifications/Pricing/Documents/AI Knowledge）；
 * - AI 分析/生成统一入参 `{ sources }`（§3.2/§3.3），产出四类知识条目；
 * - `costPrice` 仅进结构化 Pricing（报价引擎 09 输入），绝不进 AI prompt（§7 红线）。
 */
import { z } from 'zod';

/** product_status（ER 06 / 00 §3.6） */
export const PRODUCT_STATUS_VALUES = ['active', 'draft', 'archived'] as const;

/** product_doc_type（ER 06；接口 08 §1.5） */
export const PRODUCT_DOC_TYPES = ['catalog', 'certification', 'test_report', 'other'] as const;

/** 产品资料白名单/上限（对齐知识中心 11 §3.1：pdf/docx/md/txt，≤50MB） */
export const PRODUCT_FILE_TYPES = ['pdf', 'docx', 'md', 'txt'] as const;
export const PRODUCT_MAX_FILE_SIZE = 50 * 1024 * 1024;

/** generate/analyze 生成输入开关（§3.2：结构化数据 Overview/Specifications/Pricing + 已索引资料） */
export const PRODUCT_KNOWLEDGE_SOURCES = ['specifications', 'pricing', 'documents'] as const;

/** 金额（字符串/数字）→ 定点字符串（numeric 列；保留 2 位小数） */
function moneyInput(message: string) {
  return z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .refine((v) => v !== '' && /^\d+(\.\d+)?$/.test(v), { message });
}

export const productSpecSchema = z.object({
  name: z.string().trim().min(1).max(100),
  value: z.string().trim().min(1).max(200),
  unit: z.string().trim().max(20).optional(),
});
export type ProductSpecDto = z.infer<typeof productSpecSchema>;

export const productPriceTierSchema = z.object({
  minQty: z.number().int().positive(),
  unitPrice: moneyInput('unitPrice 需为非负数字'),
});
export type ProductPriceTierDto = z.infer<typeof productPriceTierSchema>;

/** §1.7 添加/编辑产品表单（基础对象；create 追加跨字段校验） */
const baseProductSchema = z.object({
  name: z.string().trim().min(1, '产品名不能为空').max(200),
  sku: z.string().trim().min(1, 'SKU 不能为空').max(64),
  category: z.string().trim().max(100).optional(),
  /** 主图 URL（列名 image_url） */
  image: z.string().trim().max(1000).optional(),
  moq: z.number().int().positive('起订量需为正整数'),
  moqUnit: z.string().trim().min(1).max(20).default('pcs'),
  leadTimeDays: z.number().int().min(0).max(3650),
  material: z.string().trim().max(200).optional(),
  description: z.string().trim().max(5000).optional(),
  costPrice: moneyInput('costPrice 需为非负数字'),
  currency: z.string().trim().length(3).default('USD'),
  suggestedPrice: moneyInput('suggestedPrice 需为非负数字').optional(),
  status: z.enum(PRODUCT_STATUS_VALUES).default('draft'),
  specifications: z.array(productSpecSchema).max(50).default([]),
  priceTiers: z.array(productPriceTierSchema).max(20).default([]),
});

/** §3.1 POST 新增（阶梯起始数量不得重复，否则违背 uq_product_tier_min_qty） */
export const createProductSchema = baseProductSchema.superRefine((val, ctx) => {
  const seen = new Set<number>();
  val.priceTiers.forEach((tier, index) => {
    if (seen.has(tier.minQty)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['priceTiers', index, 'minQty'],
        message: `阶梯起始数量重复：${tier.minQty}`,
      });
    }
    seen.add(tier.minQty);
  });
});
export type CreateProductDto = z.infer<typeof createProductSchema>;

/** §2 PUT 编辑（字段可选，仅更新传入项） */
export const updateProductSchema = baseProductSchema.partial();
export type UpdateProductDto = z.infer<typeof updateProductSchema>;

/** §2 GET /products 筛选（keyword 复用分页契约） */
export const listProductsQuerySchema = z.object({
  category: z.string().trim().max(100).optional(),
  status: z.enum(PRODUCT_STATUS_VALUES).optional(),
});
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

/** §3.2/§3.3 AI 分析/生成入参（sources 缺省=结构化+资料全量） */
export const productKnowledgeRequestSchema = z.object({
  sources: z
    .array(z.enum(PRODUCT_KNOWLEDGE_SOURCES))
    .min(1)
    .default([...PRODUCT_KNOWLEDGE_SOURCES]),
});
export type ProductKnowledgeRequestDto = z.infer<typeof productKnowledgeRequestSchema>;

/** §1.5 上传资料（multipart：file + docType） */
export const uploadProductDocumentSchema = z.object({
  docType: z.enum(PRODUCT_DOC_TYPES),
});
export type UploadProductDocumentDto = z.infer<typeof uploadProductDocumentSchema>;
