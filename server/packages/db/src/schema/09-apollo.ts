import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { apolloRunStatus } from './enums.js';
import { org } from './01-org-user.js';
import { customer } from './04-customer.js';

/**
 * ER Apollo · Apollo 相似客户获客（种子画像 → 关键词 → 搜索 → AI 复筛）。
 * 每轮获客流程一行 run，串起四步工作流的中间产物；复筛通过的客户落 ai_lead（source=apollo）。
 */

/** 步骤② 产物：种子画像拆解出的 Apollo 搜索参数（前端可编辑后重跑） */
export interface ApolloSearchParams {
  /** Apollo q_organization_keyword_tags：行业/产品关键词 */
  keywordTags: string[];
  /** Apollo organization_locations：目标市场（国家/城市，英文） */
  locations: string[];
  /** Apollo organization_num_employees_ranges：[min, max][]，[0,0] 表示不限 */
  employeeRanges: [number, number][];
  /** 联系人头衔过滤（people search 的 person_titles） */
  contactTitles: string[];
  /** 拆解理由（LLM 产出，供用户校对） */
  rationale: string;
}

/** 步骤③ 产物：Apollo 返回的公司（含联系人）原始快照 */
export interface ApolloOrgResult {
  apolloOrgId: string;
  companyName: string;
  website: string | null;
  /** 归一化域名（去 www.，三级去重口径） */
  domain: string | null;
  country: string | null;
  industry: string | null;
  employeeCount: number | null;
  linkedinUrl: string | null;
  shortDescription: string | null;
  contacts: {
    apolloPersonId: string;
    name: string;
    title: string | null;
    email: string | null;
    /** Apollo email_status：verified / presumed_valid / locked / unavailable 等 */
    emailStatus: string | null;
    linkedinUrl: string | null;
    seniority: string | null;
  }[];
}

/** 步骤④ 产物：单公司 AI 复筛结论 */
export interface ApolloAnalyzeResult {
  apolloOrgId: string;
  companyName: string;
  matchPct: number;
  /** high / medium / low（对齐 ai_lead.score_level 口径） */
  scoreLevel: 'high' | 'medium' | 'low';
  qualified: boolean;
  reasons: { text: string; evidence?: string }[];
  /** 不符合目标画像的剔除原因（qualified=false 时给出） */
  rejectReason?: string;
}

export const apolloSearchRun = pgTable(
  'apollo_search_run',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    /** 种子客户（如 EASYFEET）；手动输入公司名时为空（画像存 seed_profile） */
    seedCustomerId: text('seed_customer_id').references(() => customer.id),
    /** 发起人 */
    createdBy: text('created_by').notNull(),
    status: apolloRunStatus('status').notNull().default('keywords_ready'),
    /** 种子画像快照（客户字段 + 联系人 + 标签，步骤①产物） */
    seedProfile: jsonb('seed_profile').$type<Record<string, unknown>>().notNull(),
    /** 步骤②产物：LLM 拆解出的 Apollo 搜索参数 */
    searchParams: jsonb('search_params').$type<ApolloSearchParams>(),
    /** 步骤③产物：Apollo 公司+联系人原始结果 */
    results: jsonb('results').$type<ApolloOrgResult[]>(),
    /** 步骤④产物：逐公司 AI 复筛结论 */
    analyzeResults: jsonb('analyze_results').$type<ApolloAnalyzeResult[]>(),
    /** 汇总：总数 / 通过数 / 入库数 */
    totalCompanies: integer('total_companies').notNull().default(0),
    qualifiedCount: integer('qualified_count').notNull().default(0),
    savedLeadCount: integer('saved_lead_count').notNull().default(0),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_apollo_run_org_created').on(t.orgId, t.createdAt.desc()),
    index('idx_apollo_run_org_seed').on(t.orgId, t.seedCustomerId),
  ],
);
