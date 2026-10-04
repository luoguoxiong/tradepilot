/**
 * Apollo 相似客户获客 API（四步工作流）：
 * ① 种子画像 → ② AI 拆解关键词 → ③ Apollo 检索 → ④ AI 复筛入库。
 */
import type {
  ApolloAnalyzeResult,
  ApolloOrgResult,
  ApolloRun,
  ApolloRunListItem,
  ApolloSearchParams,
  ApolloSeedProfile,
} from '@/api/types/apollo'
import { request } from '../http'

/** 步骤① 读取种子客户画像 */
export function fetchSeedProfile(customerId: string) {
  return request<ApolloSeedProfile>({
    url: '/apollo-acquisition/seed-profile',
    method: 'GET',
    params: { customerId },
  })
}

/** 步骤② AI 拆解种子画像 → Apollo 搜索参数（创建 run；customerId 或手动输入 companyName 二选一） */
export function generateApolloKeywords(data: {
  customerId?: string
  companyName?: string
  country?: string
  website?: string
  industry?: string
  remark?: string
  extraGoal?: string
}) {
  return request<{ runId: string; searchParams: ApolloSearchParams }>({
    url: '/apollo-acquisition/keywords',
    method: 'POST',
    data,
  })
}

/** 步骤③ Apollo 公司 + 联系人检索 */
export function runApolloSearch(
  runId: string,
  data: { searchParams?: Partial<ApolloSearchParams>; page?: number; perPage?: number } = {},
) {
  return request<{ runId: string; totalCompanies: number; results: ApolloOrgResult[] }>({
    url: `/apollo-acquisition/runs/${runId}/search`,
    method: 'POST',
    data,
  })
}

/** 步骤④ AI 二次复筛 → 符合条件的写入客户发现池 */
export function runApolloAnalyze(runId: string, data: { threshold?: number } = {}) {
  return request<{
    runId: string
    totalCompanies: number
    qualifiedCount: number
    savedLeadCount: number
    analyzeResults: ApolloAnalyzeResult[]
  }>({
    url: `/apollo-acquisition/runs/${runId}/analyze`,
    method: 'POST',
    data,
  })
}

/** 轮次列表 */
export function fetchApolloRuns(params: { seedCustomerId?: string } = {}) {
  return request<{ runs: ApolloRunListItem[] }>({
    url: '/apollo-acquisition/runs',
    method: 'GET',
    params,
  })
}

/** 轮次详情 */
export function fetchApolloRun(runId: string) {
  return request<ApolloRun>({
    url: `/apollo-acquisition/runs/${runId}`,
    method: 'GET',
  })
}
