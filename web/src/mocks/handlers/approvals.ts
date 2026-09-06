import { http, delay } from 'msw'

import { mockApprovalTabs } from '../data/db'
import { LATENCY, ok } from '../utils'

/** GET /approvals/summary（12 接口文档 §3.1）：notifyStore 轮询数据源 */
export const approvalHandlers = [
  http.get('/api/v1/approvals/summary', async () => {
    await delay(LATENCY)
    return ok({ tabs: mockApprovalTabs })
  }),
]
