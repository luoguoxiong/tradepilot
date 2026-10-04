/**
 * Apollo 相似客户获客 DTO（四步工作流）：
 * 种子画像 → LLM 拆解关键词 → Apollo 检索 → AI 二次复筛落 ai_lead。
 */
import { z } from 'zod';

/** 步骤② 产物/步骤③ 入参：Apollo 搜索参数（用户可在检索前编辑） */
export const apolloSearchParamsSchema = z.object({
  keywordTags: z.array(z.string().trim().min(1).max(100)).min(1).max(10),
  locations: z.array(z.string().trim().min(1).max(100)).max(10),
  employeeRanges: z
    .array(
      z
        .tuple([z.number().int().min(0), z.number().int().min(0)])
        .refine(([min, max]) => max === 0 || max >= min, '规模区间 max 需 ≥ min（0 表示不限）'),
    )
    .max(3),
  contactTitles: z.array(z.string().trim().min(1).max(100)).max(10),
  rationale: z.string().max(2000),
});
export type ApolloSearchParamsDto = z.infer<typeof apolloSearchParamsSchema>;

/** 步骤① GET /apollo-acquisition/seed-profile?customerId= */
export const seedProfileQuerySchema = z.object({
  customerId: z.string().trim().min(1),
});
export type SeedProfileQuery = z.infer<typeof seedProfileQuerySchema>;

/** 步骤② POST /apollo-acquisition/keywords（customerId 或手动输入 companyName 二选一） */
export const generateKeywordsSchema = z
  .object({
    /** 从 CRM 选种子客户 */
    customerId: z.string().trim().min(1).optional(),
    /** 手动输入种子公司名（不在 CRM 也可） */
    companyName: z.string().trim().min(1).max(200).optional(),
    country: z.string().trim().min(1).max(100).optional(),
    website: z.string().trim().min(1).max(300).optional(),
    industry: z.string().trim().min(1).max(200).optional(),
    remark: z.string().trim().min(1).max(1000).optional(),
    /** 可选补充目标（如"重点找北美批发商"），LLM 拆解时并入考量 */
    extraGoal: z.string().trim().max(500).optional(),
  })
  .refine((v) => Boolean(v.customerId || v.companyName), 'customerId 与 companyName 至少提供一个');
export type GenerateKeywordsDto = z.infer<typeof generateKeywordsSchema>;

/** 步骤③ POST /apollo-acquisition/runs/:id/search */
export const apolloSearchSchema = z.object({
  /** 用户编辑后的搜索参数（不传沿用步骤②产物） */
  searchParams: apolloSearchParamsSchema.partial({ rationale: true }).optional(),
  /** Apollo 页码（默认 1） */
  page: z.number().int().min(1).max(20).optional(),
  /** 每页公司数（默认 25，Apollo 上限 100；联系人按命中公司逐批检索） */
  perPage: z.number().int().min(1).max(100).optional(),
});
export type ApolloSearchDto = z.infer<typeof apolloSearchSchema>;

/** 步骤④ POST /apollo-acquisition/runs/:id/analyze */
export const apolloAnalyzeSchema = z.object({
  /** 入库阈值：matchPct ≥ threshold 视为符合目标客户（默认 60） */
  threshold: z.number().int().min(0).max(100).optional(),
});
export type ApolloAnalyzeDto = z.infer<typeof apolloAnalyzeSchema>;

/** GET /apollo-acquisition/runs 查询参数 */
export const listApolloRunsQuerySchema = z.object({
  seedCustomerId: z.string().trim().min(1).optional(),
});
export type ListApolloRunsQuery = z.infer<typeof listApolloRunsQuerySchema>;
