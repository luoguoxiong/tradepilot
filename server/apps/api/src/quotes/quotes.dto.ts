/**
 * 09 报价中心 DTO（页面级接口文档 09 §1/§3，P1）：
 * - 列表（status Tab / keyword）→ §2；新建/编辑（仅 draft 可编辑）；
 * - 明细行：quantity < MOQ → 42201；validUntil <= 今天 → 42201（§3.1）；
 * - 成本快照（明细行级）与汇率快照（报价头）由定价引擎核算、draft 可人工覆盖；
 * - 状态机（v0.4）：draft → waiting_approval → sent → won；draft/waiting_approval/sent → lost；lost → draft。
 */
import { z } from 'zod';

/** quote_status（ER 07 / 00 §3.6） */
export const QUOTE_STATUS_VALUES = ['draft', 'waiting_approval', 'sent', 'won', 'lost'] as const;
export type QuoteStatusValue = (typeof QUOTE_STATUS_VALUES)[number];

/** 列表 Tab（§1.1：all + 五个状态，各档数量） */
export const QUOTE_TABS = ['all', 'draft', 'waiting_approval', 'sent', 'won', 'lost'] as const;

/** 失效原因枚举（§3.7：选填，降低操作摩擦） */
export const QUOTE_LOST_REASONS = [
  'price',
  'no_response',
  'competitor',
  'timing',
  'other',
] as const;

/** ISO 4217 币种（三位大写字母） */
const currencySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, '币种需为 ISO 4217 三位字母')
  .transform((v) => v.toUpperCase());

/** 日期 `YYYY-MM-DD` */
const dateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');

/** 金额（字符串/数字）→ 定点字符串（numeric 列） */
function amountInput(message: string, positive = false) {
  return z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .refine((v) => v !== '' && /^\d+(\.\d+)?$/.test(v), { message })
    .refine((v) => (positive ? Number(v) > 0 : Number(v) >= 0), { message });
}

/** 五项成本快照人工覆盖（draft 态可改；未传项回落引擎核算值） */
const costSnapshotSchema = z.object({
  purchase: amountInput('purchase 需为非负数字').optional(),
  freight: amountInput('freight 需为非负数字').optional(),
  insurance: amountInput('insurance 需为非负数字').optional(),
  tax: amountInput('tax 需为非负数字').optional(),
  fx: amountInput('fx 需为非负数字').optional(),
});

/** §1.3 明细行 */
export const quoteItemSchema = z.object({
  productId: z.string().trim().min(1, 'productId 不能为空').max(64),
  quantity: z.number().int().positive('数量需为正整数'),
  unitPrice: amountInput('unitPrice 需为正数', true),
  /** draft 态人工覆盖成本快照（§3.1） */
  costSnapshot: costSnapshotSchema.optional(),
});
export type QuoteItemDto = z.infer<typeof quoteItemSchema>;

/** 汇率快照入参（缺省回落 16 `exchangeRateSource` + 当天 + 1.0 同币种） */
export const quoteExchangeRateSchema = z.object({
  rate: amountInput('exchangeRate.rate 需为正数', true),
  date: dateSchema.optional(),
  source: z.string().trim().min(1).max(32).optional(),
});

/** §3.1 新建报价（报价头结构化字段全必填） */
export const createQuoteSchema = z.object({
  customerId: z.string().trim().min(1, 'customerId 不能为空').max(64),
  contactId: z.string().trim().min(1).max(64).optional(),
  currency: currencySchema.default('USD'),
  incoterms: z.string().trim().min(1, 'incoterms 不能为空').max(32),
  validUntil: dateSchema,
  paymentTerms: z.string().trim().min(1, 'paymentTerms 不能为空').max(200),
  exchangeRate: quoteExchangeRateSchema.optional(),
  items: z.array(quoteItemSchema).min(1, '至少一条明细行').max(200),
});
export type CreateQuoteDto = z.infer<typeof createQuoteSchema>;

/** §2 PUT 编辑（仅 draft 可编辑；字段可选） */
export const updateQuoteSchema = createQuoteSchema.partial();
export type UpdateQuoteDto = z.infer<typeof updateQuoteSchema>;

/** §2 GET /quotes 列表筛选（status Tab + keyword=编号/客户名） */
export const listQuotesQuerySchema = z.object({
  status: z.enum(QUOTE_STATUS_VALUES).optional(),
  customerId: z.string().trim().min(1).max(64).optional(),
  tab: z.enum(QUOTE_TABS).optional(),
});
export type ListQuotesQuery = z.infer<typeof listQuotesQuerySchema>;

/** §3.2 AI 定价建议入参（缺省取报价首行明细；不落库） */
export const aiPricingRequestSchema = z.object({
  productId: z.string().trim().min(1).max(64).optional(),
  quantity: z.number().int().positive().optional(),
  unitPrice: amountInput('unitPrice 需为正数', true).optional(),
});
export type AiPricingRequestDto = z.infer<typeof aiPricingRequestSchema>;

/** §3.7 标记失效（reason 选填） */
export const markLostSchema = z.object({
  reason: z.enum(QUOTE_LOST_REASONS).optional(),
});
export type MarkLostDto = z.infer<typeof markLostSchema>;
