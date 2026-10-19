import { request } from '../http'
import type {
  DashboardDailyReport,
  DashboardSummary,
  GenerateDailyReportReq,
  GenerateDailyReportResp,
} from '../types/dashboard'

/** 01-Dashboard 工作台（接口文档 01 §2 接口清单；只读聚合 + D3 报告生成触发） */

/** GET /dashboard/summary：首屏聚合（greeting/kpis/aiEmployees/highValueCustomers/pendingItems） */
export function getDashboardSummary() {
  return request<DashboardSummary>({ url: '/dashboard/summary', method: 'GET' })
}

/** GET /dashboard/daily-report：最新 AI 每日报告（无日报 → 40401，调用侧按空态处理） */
export function getDashboardDailyReport() {
  return request<DashboardDailyReport>({ url: '/dashboard/daily-report', method: 'GET' })
}

/** POST /dashboard/daily-report/generate：触发生成（异步任务，worker 产出五段 Markdown） */
export function generateDashboardDailyReport(data: GenerateDailyReportReq = {}) {
  return request<GenerateDailyReportResp>({
    url: '/dashboard/daily-report/generate',
    method: 'POST',
    data,
  })
}
