import type {
  ApprovalItem,
  ApprovalListReq,
  ApprovalLog,
  ApprovalSummary,
  ApproveReq,
  ApproveResp,
  RejectReq,
} from '@/api/types/approvals'
import type { PageResp } from '@/api/types/common'

import { request } from '../http'

/** 各类型待审数量（12 §3.1）——notifyStore 15s 轮询 / 审核中心 Tab 共用 */
export function fetchApprovalSummary() {
  return request<ApprovalSummary>({ url: '/approvals/summary', method: 'GET' })
}

/** GET /approvals：审批列表（type/status 筛选 + 分页，12 §3.2） */
export function fetchApprovals(params: ApprovalListReq) {
  return request<PageResp<ApprovalItem>>({ url: '/approvals', method: 'GET', params })
}

/** GET /approvals/{id}：审批详情（卡片字段，12 §1.2） */
export function fetchApprovalDetail(approvalId: string) {
  return request<ApprovalItem>({ url: `/approvals/${approvalId}`, method: 'GET' })
}

/** POST /approvals/{id}/approve：批准（二选一 approve / edited_approved，12 §3.3） */
export function approveApproval(approvalId: string, data: ApproveReq) {
  return request<ApproveResp>({ url: `/approvals/${approvalId}/approve`, method: 'POST', data })
}

/** POST /approvals/{id}/reject：拒绝（reason 必填，缺失 42201，12 §3.4） */
export function rejectApproval(approvalId: string, data: RejectReq) {
  return request<{ approvalId: string; status: string }>({
    url: `/approvals/${approvalId}/reject`,
    method: 'POST',
    data,
  })
}

/** GET /approvals/{id}/logs：审核留痕（12 §1.5） */
export function fetchApprovalLogs(approvalId: string) {
  return request<ApprovalLog[]>({ url: `/approvals/${approvalId}/logs`, method: 'GET' })
}
