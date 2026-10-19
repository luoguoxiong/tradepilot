import type { DataScope, PageReq, PageResp } from '@/api/types/common'

/**
 * AI 外贸经理类型（接口文档 13 §1/§3，P1-13）。
 * 与后端 `apps/api/src/manager/manager.dto.ts` 一一对应（唯一事实源）。
 */

/** 报告周期（13 §1.4；与后端 MANAGER_REPORT_PERIODS 一致） */
export type ManagerReportPeriod = 'daily' | 'weekly' | 'monthly'

/** 报告周期全集（下拉遍历） */
export const MANAGER_REPORT_PERIODS: readonly ManagerReportPeriod[] = ['daily', 'weekly', 'monthly']

/** 发现类型筛选（13 §1.2） */
export type ManagerDiscoveryType = 'all' | 'opportunity' | 'risk'

/** 发现类型全集（Tab 遍历） */
export const MANAGER_DISCOVERY_TYPES: readonly ManagerDiscoveryType[] = [
  'all',
  'opportunity',
  'risk',
]

/** §1.1 今日经营概览（四项核心指标，与 15 数据中心同源） */
export interface ManagerOverview {
  newCustomers: number
  newInquiries: number
  newQuotes: number
  dealsClosed: number
}

export interface ManagerOverviewReq {
  /** 当地日 YYYY-MM-DD；缺省今天（org 时区） */
  date?: string
  scope?: DataScope
}

/** 发现证据（Insight Schema：text 必填；source/ref 供下钻） */
export interface DiscoveryEvidence {
  text: string
  source?: string
  ref?: string
}

/** 一键建议（action 白名单：start_lead_task / enable_reactivation_strategy） */
export interface DiscoverySuggestion {
  label: string
  action: string
  payload: Record<string, unknown>
}

/** §1.2 发现项 */
export interface ManagerDiscovery {
  discoveryId: string
  type: string
  title: string
  detail: string
  evidence: DiscoveryEvidence[]
  suggestion: DiscoverySuggestion
  /** 按钮展示文案（由 action 映射，只读） */
  actions: string
  /** new（待处理）/ executed（已执行） */
  status: string
  executedRef: Record<string, unknown> | null
  executedAt: string | null
  createdAt: string
}

export interface DiscoveryListReq {
  type?: ManagerDiscoveryType
  scope?: DataScope
}

export interface DiscoveryListResp {
  items: ManagerDiscovery[]
}

/** §1.3 团队效率行：target 未配置时不返回 kpiPct/metric/target */
export interface TeamEfficiencyItem {
  employeeId: string
  role: string
  name: string
  kpiPct?: number
  metric?: string
  achieved?: number
  target?: number
  period?: string
}

export interface TeamEfficiencyResp {
  items: TeamEfficiencyItem[]
}

/** §3.3 一键执行结果 */
export interface ExecuteDiscoveryResp {
  discoveryId: string
  action: string
  taskId?: string
  strategyId?: string
}

/** §3.4 生成报告请求 / 响应 */
export interface GenerateReportReq {
  period: ManagerReportPeriod
}

export interface GenerateReportResp {
  taskId: string
  reportId: string
  status: string
  period: string
}

/** §1.4 报告列表行 */
export interface ManagerReportListItem {
  reportId: string
  period: string
  periodStart: string
  periodEnd: string
  status: string
  taskId: string | null
  generatedAt: string | null
  createdAt: string
}

/** §1.4 报告详情（content 为五段 Markdown） */
export interface ManagerReportDetail extends ManagerReportListItem {
  content: string | null
  citations: Record<string, unknown>[]
}

export interface ReportListReq extends PageReq {
  period?: ManagerReportPeriod | 'all'
  scope?: DataScope
}

export type ReportListResp = PageResp<ManagerReportListItem>
