import { http, delay } from 'msw'

import { ErrorCode } from '@/api/error-codes'

import { mockDashboardSummary } from '../data/dashboard'
import { LATENCY, fail, ok } from '../utils'

/**
 * 01 Dashboard mock（06 §5.3 mock 即契约）：
 * - GET /summary 返回 P0 降级结构（D1~D3，未启用 metric/入口不返回）；
 * - daily-report 两接口 P0 保留但恒 40401（13 为 P1）。
 */
export const dashboardHandlers = [
  http.get('/api/v1/dashboard/summary', async () => {
    await delay(LATENCY)
    return ok(mockDashboardSummary)
  }),

  http.get('/api/v1/dashboard/daily-report', async () => {
    await delay(LATENCY)
    return fail(ErrorCode.NOT_FOUND, 'AI 每日报告将在 AI 外贸经理上线后开放')
  }),

  http.post('/api/v1/dashboard/daily-report/generate', async () => {
    await delay(LATENCY)
    return fail(ErrorCode.NOT_FOUND, 'AI 每日报告将在 AI 外贸经理上线后开放')
  }),
]
