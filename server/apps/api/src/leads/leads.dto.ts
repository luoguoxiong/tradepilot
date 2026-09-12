/**
 * 03 AI 获客 DTO（接口 03 §1.2/§3，M5-B2）。
 * parse / leads 列表/详情/summary / add-to-crm / batch-analyze。
 */
import { z } from 'zod';

export const LEAD_VALUE_LEVELS = ['high', 'medium', 'low', 'all'] as const;
export type LeadValueLevel = (typeof LEAD_VALUE_LEVELS)[number];

/**
 * 布尔查询参数解析。
 * 不能用 `z.coerce.boolean()`：其实现为 `Boolean(input)`，字符串 'false' 同样为真
 * （`Boolean('false') === true`），会把 `?inCrm=false` 误判为 true 而过滤掉全部未转化 lead。
 */
const booleanQueryParam = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((v) => v === true || v === 'true');

/** 3.1 POST /lead-tasks/parse */
export const parseLeadTaskSchema = z.object({
  goalText: z.string().trim().min(1).max(2000),
});
export type ParseLeadTaskDto = z.infer<typeof parseLeadTaskSchema>;

/** 3.2 POST /lead-tasks 创建获客任务 */
export const createLeadTaskSchema = z.object({
  goalText: z.string().trim().min(1).max(2000),
  parsed: z.object({
    targetMarket: z.string().trim().min(1).max(200),
    customerType: z.string().trim().min(1).max(200),
    targetProduct: z.string().trim().min(1).max(200),
    companySize: z.string().trim().max(200).optional(),
  }),
  advancedSettings: z
    .object({
      companySizeRange: z
        .object({
          min: z.number().int().min(0).optional(),
          max: z.number().int().min(0).optional(),
        })
        .optional(),
      annualImportRange: z.string().optional(),
      jobTitles: z.array(z.string()).optional(),
      excludeDomains: z.array(z.string()).optional(),
      matchThresholds: z
        .object({
          high: z.number().int().min(0).max(100),
          medium: z.number().int().min(0).max(100),
        })
        .optional(),
    })
    .optional(),
  targetCount: z.number().int().min(1).max(1000).optional(),
  /**
   * 执行员工 id。03 §3.2 请求示例含该字段，但 §1.3 创建表单字段表并无此项（用户不可见），
   * 前端不传 → 由服务端按 org 的 lead_hunter 兜底解析，缺失才报错。
   */
  employeeId: z.string().trim().min(1).optional(),
});
export type CreateLeadTaskDto = z.infer<typeof createLeadTaskSchema>;

/** 3.3 GET /leads 查询参数 */
export const listLeadsQuerySchema = z.object({
  valueLevel: z.enum(LEAD_VALUE_LEVELS).optional(),
  keyword: z.string().trim().max(200).optional(),
  country: z.string().trim().max(100).optional(),
  industry: z.string().trim().max(200).optional(),
  minMatchPct: z.coerce.number().int().min(0).max(100).optional(),
  taskId: z.string().trim().min(1).optional(),
  inCrm: booleanQueryParam.optional(),
});
export type ListLeadsQuery = z.infer<typeof listLeadsQuerySchema>;

/** 3.4 POST /leads/add-to-crm */
export const addToCrmSchema = z.object({
  leadIds: z.array(z.string().trim().min(1)).min(1).max(100),
  ownerId: z.string().trim().min(1).optional(),
});
export type AddToCrmDto = z.infer<typeof addToCrmSchema>;

/** 3.5 POST /leads/batch-analyze */
export const batchAnalyzeSchema = z.object({
  leadIds: z.array(z.string().trim().min(1)).min(1).max(50),
});
export type BatchAnalyzeDto = z.infer<typeof batchAnalyzeSchema>;

/** B3 POST /leads/{id}/convert */
export const convertLeadSchema = z.object({
  ownerId: z.string().trim().min(1).optional(),
});
export type ConvertLeadDto = z.infer<typeof convertLeadSchema>;
