import { http, delay } from 'msw'

import { countDeleteLockedCustomers } from '../data/customers'
import { LATENCY, ok } from '../utils'

/**
 * GET /approvals/summary（12 接口文档 §3.1）：notifyStore 轮询数据源。
 * customer_delete 计数联动 CRM 删除审批流（05 §3.3：删除 → delete_locked），
 * 避免与客户中心删除操作漂移；email_send 为 P0 静态基线（04 mock 展开）。
 */
export const approvalHandlers = [
  http.get('/api/v1/approvals/summary', async () => {
    await delay(LATENCY)
    const emailSend = 2
    const customerDelete = countDeleteLockedCustomers()
    return ok({
      tabs: [
        { type: 'all', count: emailSend + customerDelete },
        { type: 'email_send', count: emailSend },
        { type: 'customer_delete', count: customerDelete },
      ],
    })
  }),
]
