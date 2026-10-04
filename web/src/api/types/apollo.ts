/** Apollo 相似客户获客类型（四步工作流） */

export interface ApolloSearchParams {
  keywordTags: string[]
  locations: string[]
  /** [min, max][]，max=0 表示不限 */
  employeeRanges: [number, number][]
  contactTitles: string[]
  rationale: string
}

export interface ApolloSeedProfile {
  /** CRM 种子客户 id；手动输入公司名时为空串 */
  customerId: string
  companyName: string
  country: string
  website: string | null
  industry: string | null
  industryTags: string[]
  customerType: string | null
  stage: string
  score: number | null
  remark: string | null
  contacts: { name: string; title: string | null; email: string | null }[]
  insights: { type: string; value: string | null; confidence: string | null; reasons: string[] }[]
}

export interface ApolloContact {
  apolloPersonId: string
  name: string
  title: string | null
  email: string | null
  emailStatus: string | null
  linkedinUrl: string | null
  seniority: string | null
}

export interface ApolloOrgResult {
  apolloOrgId: string
  companyName: string
  website: string | null
  domain: string | null
  country: string | null
  industry: string | null
  employeeCount: number | null
  linkedinUrl: string | null
  shortDescription: string | null
  contacts: ApolloContact[]
}

export interface ApolloAnalyzeResult {
  apolloOrgId: string
  companyName: string
  matchPct: number
  scoreLevel: 'high' | 'medium' | 'low'
  qualified: boolean
  reasons: { text: string; evidence?: string }[]
  rejectReason?: string
}

/** apollo_search_run 行（GET /apollo-acquisition/runs/:id） */
export interface ApolloRun {
  id: string
  orgId: string
  /** CRM 种子客户 id；手动输入公司名时为 null */
  seedCustomerId: string | null
  createdBy: string
  status: 'keywords_ready' | 'searched' | 'analyzed' | 'failed'
  seedProfile: ApolloSeedProfile
  searchParams: ApolloSearchParams | null
  results: ApolloOrgResult[] | null
  analyzeResults: ApolloAnalyzeResult[] | null
  totalCompanies: number
  qualifiedCount: number
  savedLeadCount: number
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

/** 轮次列表行（不含大 JSON 字段） */
export interface ApolloRunListItem {
  id: string
  seedCustomerId: string | null
  status: ApolloRun['status']
  searchParams: ApolloSearchParams | null
  totalCompanies: number
  qualifiedCount: number
  savedLeadCount: number
  errorMessage: string | null
  createdAt: string
}
