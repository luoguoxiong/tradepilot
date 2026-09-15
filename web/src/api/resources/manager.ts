import { request } from '../http'
import type {
  DiscoveryListReq,
  DiscoveryListResp,
  ExecuteDiscoveryResp,
  GenerateReportReq,
  GenerateReportResp,
  ManagerOverview,
  ManagerOverviewReq,
  ManagerReportDetail,
  ReportListReq,
  ReportListResp,
  TeamEfficiencyResp,
} from '@/api/types/manager'

/**
 * AI 外贸经理接口封装（接口文档 13 §3，P1-13-01~07）。
 * 发现列表为「读取即刷新」：服务端按当前窗口重算并幂等写回后返回。
 */

/** 13 §3.1 今日经营概览（date 缺省今天） */
export function getManagerOverview(params: ManagerOverviewReq = {}) {
  return request<ManagerOverview>({ url: '/manager/overview', method: 'GET', params })
}

/** 13 §3.2 AI 发现列表（机会 + 风险） */
export function getManagerDiscoveries(params: DiscoveryListReq = {}) {
  return request<DiscoveryListResp>({ url: '/manager/discoveries', method: 'GET', params })
}

/** 13 §3.3 一键执行建议（发起类动作；外发仍走审批） */
export function executeDiscovery(discoveryId: string) {
  return request<ExecuteDiscoveryResp>({
    url: `/manager/discoveries/${discoveryId}/execute`,
    method: 'POST',
  })
}

/** 13 §1.3 AI 团队效率（与 02 员工卡片同源） */
export function getTeamEfficiency() {
  return request<TeamEfficiencyResp>({ url: '/manager/team-efficiency', method: 'GET' })
}

/** 13 §3.4 生成经营报告（异步任务） */
export function generateManagerReport(data: GenerateReportReq) {
  return request<GenerateReportResp>({ url: '/manager/reports/generate', method: 'POST', data })
}

/** 13 §1.4 报告列表 */
export function getManagerReports(params: ReportListReq = {}) {
  return request<ReportListResp>({ url: '/manager/reports', method: 'GET', params })
}

/** 13 §1.4 报告详情（五段 Markdown + citations） */
export function getManagerReport(reportId: string) {
  return request<ManagerReportDetail>({ url: `/manager/reports/${reportId}`, method: 'GET' })
}
