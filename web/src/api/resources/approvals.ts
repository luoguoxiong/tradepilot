import type { ApprovalSummary } from '@/api/types/approvals'

import { request } from '../http'

/** 各类型待审数量（12 §3.1）——notifyStore 15s 轮询 / 审核中心 Tab 共用 */
export function fetchApprovalSummary() {
  return request<ApprovalSummary>({ url: '/approvals/summary', method: 'GET' })
}
