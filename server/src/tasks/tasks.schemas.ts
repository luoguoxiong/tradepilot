import { z } from 'zod';

export const COMPANY_TYPES = ['Importer', 'Distributor', 'Wholesaler', 'Retailer'] as const;
export const TARGET_COUNTRIES = ['US', 'CA'] as const;

export const CreateSearchTaskSchema = z.object({
  productId: z.string().min(1).optional(),
  productKeywords: z.array(z.string().trim().min(1).max(120)).min(1, '至少一个产品关键词').max(10),
  country: z.enum(TARGET_COUNTRIES, { message: '目标国家仅支持 US/CA（首期市场）' }),
  companyTypes: z.array(z.enum(COMPANY_TYPES)).min(1, '至少选择一种企业类型').max(4),
  industryKeywords: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export type CreateSearchTaskInput = z.infer<typeof CreateSearchTaskSchema>;

/** fromStep 枚举（架构 §3.2）；阶段 5 仅 searching 可执行，其余预留 */
export const RETRY_STEPS = [
  'searching',
  'enriching',
  'enriching:contacts',
  'enriching:customs',
  'enriching:enrich',
  'scoring',
  'emailing',
] as const;

export const RetryTaskSchema = z.object({
  fromStep: z.enum(RETRY_STEPS).default('searching'),
  companyId: z.string().min(1).optional(),
});

export type RetryTaskInput = z.infer<typeof RetryTaskSchema>;
