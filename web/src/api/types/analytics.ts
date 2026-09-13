import type { DataScope } from '@/api/types/common'

/**
 * 数据中心类型（接口文档 15 §3）。
 * metric 取值与后端 `@tradepilot/core` 的 `ANALYTICS_METRIC` 一一对应（15 §3.4 白名单）。
 */

/** 统计周期（15 §1.2） */
export type AnalyticsPeriod = 'this_week' | 'this_month' | 'custom'

/** 下钻指标（15 §3.4） */
export type AnalyticsMetric =
  | 'new_customers'
  | 'inquiries'
  | 'new_quotes'
  | 'deals_closed'
  | 'found_customers'
  | 'replied_emails'
  | 'saved_hours'
  | 'promoted_inquiries'

/** 下钻指标全集（Tab / 校验 / 常量遍历） */
export const ANALYTICS_METRICS: readonly AnalyticsMetric[] = [
  'new_customers',
  'inquiries',
  'new_quotes',
  'deals_closed',
  'found_customers',
  'replied_emails',
  'saved_hours',
  'promoted_inquiries',
]

/** 全局筛选（15 §1.2 / §3.2；country/employeeId 不传 = 全部） */
export interface AnalyticsFilters {
  period: AnalyticsPeriod
  /** period=custom 时必填，当地日 YYYY-MM-DD */
  startDate?: string
  endDate?: string
  country?: string
  employeeId?: string
  scope?: DataScope
}

/** 下钻请求（15 §3.4；单页 ≤100 条） */
export interface DrilldownReq extends AnalyticsFilters {
  metric: AnalyticsMetric
  page?: number
  pageSize?: number
}

/** 趋势点（15 §3.1，当日当地日） */
export interface TrendPoint {
  date: string
  newCustomers: number
  newInquiries: number
  newQuotes: number
}

/** 15 §3.1 响应 */
export interface CustomerTrendResp {
  trend: TrendPoint[]
}

/** 市场分布行（15 §3.2；OTHER = Top3 之外的合计） */
export interface MarketRow {
  country: string
  customerCount: number
  pct: number
}

/** 15 §3.2 响应 */
export interface MarketDistributionResp {
  markets: MarketRow[]
}

/** 15 §3.3 响应（savedHours 为估算指标，caliberNote 必须页面标注） */
export interface AiContributionResp {
  foundCustomers: number
  repliedEmails: number
  savedHours: number
  promotedInquiries: number
  caliberNote: string
}

/** 下钻明细行（15 §3.4；type 决定跳转目标） */
export interface DrilldownItem {
  id: string
  /** customer / conversation / quotation / message / found_customer / replied_email / follow_up */
  type: string
  title: string
  subtitle?: string | null
  country?: string | null
  ownerName?: string | null
  /** 报价为金额字符串，saved_hours 为分钟数字符串 */
  amount?: string | null
  currency?: string | null
  occurredAt: string
}

/** 15 §3.4 响应 */
export interface DrilldownResp {
  metric: AnalyticsMetric
  total: number
  page: number
  pageSize: number
  items: DrilldownItem[]
}
