import { request } from '../http'
import type { DashboardSummary } from '../types/dashboard'

/** 01-Dashboard 工作台（接口文档 01 §2 接口清单；只读聚合） */

/** GET /dashboard/summary：首屏聚合（greeting/kpis/aiEmployees/highValueCustomers/pendingItems） */
export function getDashboardSummary() {
  return request<DashboardSummary>({ url: '/dashboard/summary', method: 'GET' })
}
