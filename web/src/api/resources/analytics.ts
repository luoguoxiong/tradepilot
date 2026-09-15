import { http, request } from '@/api/http'
import type {
  AiContributionResp,
  AnalyticsFilters,
  CustomerTrendResp,
  DrilldownReq,
  DrilldownResp,
  MarketDistributionResp,
} from '@/api/types/analytics'

/**
 * 数据中心接口封装（接口文档 15 §3，P1-15-01~06）。
 * 四个只读查询共用同一组全局筛选（period/startDate/endDate/country/employeeId/scope）。
 */

/** 15 §3.1 客户增长趋势 */
export function getCustomerTrend(params: AnalyticsFilters): Promise<CustomerTrendResp> {
  return request<CustomerTrendResp>({ url: '/analytics/customer-trend', method: 'get', params })
}

/** 15 §3.2 市场分布 */
export function getMarketDistribution(params: AnalyticsFilters): Promise<MarketDistributionResp> {
  return request<MarketDistributionResp>({
    url: '/analytics/market-distribution',
    method: 'get',
    params,
  })
}

/** 15 §3.3 AI 贡献（含 caliberNote 估算口径） */
export function getAiContribution(params: AnalyticsFilters): Promise<AiContributionResp> {
  return request<AiContributionResp>({ url: '/analytics/ai-contribution', method: 'get', params })
}

/** 15 §3.4 指标下钻明细 */
export function getDrilldown(params: DrilldownReq): Promise<DrilldownResp> {
  return request<DrilldownResp>({ url: '/analytics/drilldown', method: 'get', params })
}

/** 从 Content-Disposition 解析文件名（缺省回落） */
function filenameFrom(header: unknown, fallback: string): string {
  if (typeof header !== 'string') return fallback
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header)
  return match?.[1] ? decodeURIComponent(match[1]) : fallback
}

/**
 * 15 §3.5 导出当前筛选下的数据中心报表（XLSX）。
 * 走原生 axios 取 Blob（响应体非 envelope），由浏览器触发下载。
 */
export async function exportAnalyticsReport(params: AnalyticsFilters): Promise<void> {
  const response = await http.get<Blob>('/analytics/export', {
    params,
    responseType: 'blob',
  })
  const filename = filenameFrom(response.headers['content-disposition'], 'data-center.xlsx')
  const url = URL.createObjectURL(response.data)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
