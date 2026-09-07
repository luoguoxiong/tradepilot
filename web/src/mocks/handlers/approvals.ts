import { http, delay } from 'msw'

import { ErrorCode } from '@/api/error-codes'
import type { ApprovalItem, ApprovalLog } from '@/api/types/approvals'

import {
  approvalPendingCounts,
  findApprovalItem,
  mockApprovalLogs,
  mockApprovals,
  resolveApproval,
  toApprovalItem,
  type ResolveAction,
} from '../data/approvals'
import { LATENCY, fail, ok, page, readJson } from '../utils'

/**
 * 12 AI 审核中心（12 接口文档 §2/§3）：
 * - summary/列表均由 mocks/data/approvals.ts 审批记录派生（唯一事实源）；
 * - customer_delete 注册来自 CRM 删除流（handlers/customers.ts），
 *   email_send 注册来自 06 send 分支 B（handlers/conversations.ts）；
 * - approve 回调原业务动作（12 §3.3）；expired 终态处置 → 42201，非 pending → 40901。
 */
export const approvalHandlers = [
  http.get('/api/v1/approvals/summary', async () => {
    await delay(LATENCY)
    return ok({ tabs: approvalPendingCounts() })
  }),

  http.get('/api/v1/approvals', async ({ request }) => {
    await delay(LATENCY)
    const url = new URL(request.url)
    const type = url.searchParams.get('type')
    const status = url.searchParams.get('status')
    const pageNum = Number(url.searchParams.get('page') ?? 1)
    const pageSize = Number(url.searchParams.get('pageSize') ?? 20)

    let items = [...mockApprovals]
    // D10（00 §5.1）：Tab 只渲染服务端返回的类型；type=all/缺省返回全量
    if (type && type !== 'all') items = items.filter((a) => a.approvalType === type)
    if (status === 'pending') items = items.filter((a) => a.status === 'pending')
    if (status === 'processed') {
      items = items.filter((a) => ['approved', 'edited_approved', 'rejected', 'auto_approved'].includes(a.status))
    }
    items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    return ok(
      page(
        items.slice((pageNum - 1) * pageSize, pageNum * pageSize).map(toApprovalItem),
        items.length,
        pageNum,
        pageSize,
      ),
    )
  }),

  http.get('/api/v1/approvals/:id', async ({ params }) => {
    await delay(LATENCY)
    const item = findApprovalItem(String(params.id))
    if (!item) return fail(ErrorCode.NOT_FOUND, '审批单不存在')
    return ok(item satisfies ApprovalItem)
  }),

  http.post('/api/v1/approvals/:id/approve', async ({ request, params }) => {
    await delay(LATENCY)
    const approvalId = String(params.id)
    const body = await readJson<{ action?: 'approve' | 'edited_approved'; editedContent?: { aiProposal: Record<string, unknown> } }>(request)
    if (body.action !== 'approve' && body.action !== 'edited_approved') {
      return fail(ErrorCode.BAD_REQUEST, 'action 仅支持 approve / edited_approved')
    }
    const result = resolveApproval(
      approvalId,
      body.action === 'approve' ? 'approved' : 'edited_approved',
      { editedContent: body.editedContent },
    )
    if (result.code === 42201) {
      return fail(ErrorCode.BIZ_VALIDATION, '该审批已超时关闭（终态），请重新发起')
    }
    if (result.code !== 'ok') {
      return fail(ErrorCode.CONFLICT, '该审批已处置，不可重复操作')
    }
    const record = result.record!
    return ok({
      approvalId: record.approvalId,
      status: record.status,
      resultRef: record.approvalType === 'email_send' ? { messageId: record.linkedMessageId, status: 'sent' } : undefined,
    })
  }),

  http.post('/api/v1/approvals/:id/reject', async ({ request, params }) => {
    await delay(LATENCY)
    const approvalId = String(params.id)
    const body = await readJson<{ reason?: string }>(request)
    // 拒绝理由必填（12 §3.4：缺失 42201，回流 AI 员工反馈闭环）
    if (!body.reason?.trim()) {
      return fail(ErrorCode.BIZ_VALIDATION, '拒绝理由为必填项')
    }
    const result = resolveApproval(approvalId, 'rejected' satisfies ResolveAction, {
      rejectReason: body.reason.trim(),
    })
    if (result.code === 42201) {
      return fail(ErrorCode.BIZ_VALIDATION, '该审批已超时关闭（终态），无需拒绝')
    }
    if (result.code !== 'ok') {
      return fail(ErrorCode.CONFLICT, '该审批已处置，不可重复操作')
    }
    return ok({ approvalId, status: 'rejected' })
  }),

  http.get('/api/v1/approvals/:id/logs', async ({ params }) => {
    await delay(LATENCY)
    const approvalId = String(params.id)
    const item = findApprovalItem(approvalId)
    if (!item) return fail(ErrorCode.NOT_FOUND, '审批单不存在')
    const logs: ApprovalLog[] = mockApprovalLogs[approvalId] ?? []
    return ok(logs)
  }),
]
