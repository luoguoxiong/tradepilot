/**
 * 12 AI 审核中心契约测试（12 接口文档 v0.2 §1/§2/§3）：
 * 覆盖 summary Tab 计数 / 列表过滤（type/status）/ 详情 / approve 双动作（approved/edited_approved
 * + editedDiff 留痕）/ reject 理由必填 / expired 终态 42201 / 重复处置 40901 /
 * 日志查询 / 跨模块回调（email_send → 06 消息置 sent；customer_delete → 05 真删/解锁）。
 *
 * 测试顺序有状态依赖（同文件内共享 mock 内存态，vitest 文件间隔离）。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/mocks/utils', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, LATENCY: 0 }
})

import type { PageResp } from '@/api/types/common'
import type {
  ApprovalItem,
  ApprovalLog,
  ApprovalSummary,
  ApproveResp,
} from '@/api/types/approvals'
import type { CustomerDetail } from '@/api/types/customers'
import type { ConversationDetail } from '@/api/types/conversations'

import { api, contractServer, expectFail, expectOk, expectPage } from './_server'

beforeAll(() => contractServer.listen({ onUnhandledRequest: 'error' }))
afterEach(() => contractServer.resetHandlers())
afterAll(() => contractServer.close())

describe('GET /approvals/summary 契约（12 §3.1）', () => {
  it('tabs 含 all/email_send/customer_delete 且计数与 pending 列表同源', async () => {
    const summary = expectOk(
      (await api<ApprovalSummary>('/approvals/summary')).json,
    )
    const allTab = summary.tabs.find((t) => t.type === 'all')
    const emailTab = summary.tabs.find((t) => t.type === 'email_send')
    const deleteTab = summary.tabs.find((t) => t.type === 'customer_delete')
    expect(allTab && emailTab && deleteTab).toBeTruthy()

    const pending = expectOk(
      (await api<PageResp<ApprovalItem>>('/approvals?status=pending&pageSize=50')).json,
    )
    expect(allTab!.count).toBe(pending.total)
    expect(pending.list.filter((a) => a.approvalType === 'email_send').length).toBe(emailTab!.count)
    expect(pending.list.filter((a) => a.approvalType === 'customer_delete').length).toBe(
      deleteTab!.count,
    )
  })
})

describe('GET /approvals 列表契约（12 §3.2）', () => {
  it('行字段对齐 ApprovalItem（含 context/aiProposal/reasons/confidence）', async () => {
    const { json } = await api<PageResp<ApprovalItem>>('/approvals?pageSize=50')
    const data = expectOk(json)
    const result = expectPage<ApprovalItem>(data, { pageSize: 50 })
    expect(result.total).toBeGreaterThanOrEqual(3)
    for (const row of result.list) {
      for (const key of [
        'approvalId',
        'approvalType',
        'riskLevel',
        'title',
        'status',
        'context',
        'aiProposal',
        'confidence',
        'reasons',
        'createdAt',
      ]) {
        expect(key in row, `缺少字段 ${key}`).toBe(true)
      }
    }
  })

  it('type 过滤：email_send/customer_delete；status=processed 仅终态', async () => {
    const email = expectOk(
      (await api<PageResp<ApprovalItem>>('/approvals?type=email_send&pageSize=50')).json,
    )
    expect(email.list.every((a) => a.approvalType === 'email_send')).toBe(true)

    const del = expectOk(
      (await api<PageResp<ApprovalItem>>('/approvals?type=customer_delete&pageSize=50')).json,
    )
    expect(del.list.every((a) => a.approvalType === 'customer_delete')).toBe(true)

    const processed = expectOk(
      (await api<PageResp<ApprovalItem>>('/approvals?status=processed&pageSize=50')).json,
    )
    expect(
      processed.list.every((a) =>
        ['approved', 'edited_approved', 'rejected', 'auto_approved'].includes(a.status),
      ),
    ).toBe(true)
  })

  it('created_at 倒序排列（最新在前）', async () => {
    const data = expectOk(
      (await api<PageResp<ApprovalItem>>('/approvals?pageSize=50')).json,
    )
    const times = data.list.map((a) => new Date(a.createdAt).getTime())
    for (let i = 1; i < times.length; i++) expect(times[i - 1] >= times[i]).toBe(true)
  })
})

describe('GET /approvals/{id} 详情契约（12 §3.2）', () => {
  it('email_send 详情：aiProposal.emailContent + expiresAt 齐备', async () => {
    const detail = expectOk((await api<ApprovalItem>('/approvals/appr_1')).json)
    expect(detail.approvalType).toBe('email_send')
    expect(detail.riskLevel).toBe('medium')
    expect(detail.context).toHaveProperty('conversationId', 'conv_3')
    expect(typeof detail.aiProposal.emailContent).toBe('string')
    expect(detail.expiresAt).toBeTruthy()
    expect(detail.citations?.length).toBeGreaterThan(0)
  })

  it('expired 详情（appr_2）：超时终态带 approverName=系统 留痕', async () => {
    const detail = expectOk((await api<ApprovalItem>('/approvals/appr_2')).json)
    expect(detail.status).toBe('expired')
    expect(detail.decidedAt).toBeTruthy()
  })

  it('未知审批单 40401', async () => {
    const { json } = await api('/approvals/appr_none')
    expectFail(json, 40401)
  })
})

describe('POST /approvals/{id}/approve 契约（12 §3.3）', () => {
  it('action=approve：email_send 回调原业务 → 消息置 sent + resultRef', async () => {
    // 前置：conv_2 生成草稿 + send（走分支 B：approval 策略由 mock 会话策略决定，若分支 A 则此单号不适用）
    // 此处直接用既有 email_send 单 appr_1（linked conv_3）验证回调
    const detailBefore = expectOk((await api<ConversationDetail>('/conversations/conv_3')).json)
    expect(detailBefore.messages.some((m) => m.status === 'waiting_approval')).toBe(true)

    const approved = expectOk(
      (
        await api<ApproveResp>('/approvals/appr_1/approve', {
          method: 'POST',
          body: JSON.stringify({ action: 'approve' }),
        })
      ).json,
    )
    expect(approved.status).toBe('approved')
    expect(approved.resultRef).toBeTruthy()

    const detailAfter = expectOk((await api<ConversationDetail>('/conversations/conv_3')).json)
    expect(detailAfter.messages.some((m) => m.status === 'sent')).toBe(true)
  })

  it('action=edited_approved：aiProposal 更新 + logs 记录 editedDiff', async () => {
    // 走 06 send 分支 B 生成新单（conv_1 为 approval 策略会话）
    const draft = expectOk(
      (
        await api<{ draftId: string; content: string }>('/conversations/conv_1/ai-draft', {
          method: 'POST',
          body: JSON.stringify({ basedOnMessageId: 'msg_5' }),
        })
      ).json,
    )
    const send = expectOk(
      (
        await api<{ approval?: { approvalId: string } }>('/conversations/conv_1/send', {
          method: 'POST',
          body: JSON.stringify({ messageId: draft.draftId, content: draft.content }),
        })
      ).json,
    )
    const approvalId = send.approval!.approvalId

    const edited = expectOk(
      (
        await api<ApproveResp>(`/approvals/${approvalId}/approve`, {
          method: 'POST',
          body: JSON.stringify({
            action: 'edited_approved',
            editedContent: { aiProposal: { emailContent: 'Dear Mike, final revised terms inside.' } },
          }),
        })
      ).json,
    )
    expect(edited.status).toBe('edited_approved')

    const logs = expectOk((await api<ApprovalLog[]>(`/approvals/${approvalId}/logs`)).json)
    const last = logs[logs.length - 1]
    expect(last.action).toBe('edited_approved')
    const diff = last.editedDiff?.find((d) => d.field === 'aiProposal.emailContent')
    expect(diff?.before).toBe(draft.content)
    expect(diff?.after).toBe('Dear Mike, final revised terms inside.')

    // 详情回读已更新
    const detail = expectOk((await api<ApprovalItem>(`/approvals/${approvalId}`)).json)
    expect(detail.aiProposal.emailContent).toBe('Dear Mike, final revised terms inside.')
    // 回调原业务：消息 sent
    const conv = expectOk((await api<ConversationDetail>('/conversations/conv_1')).json)
    expect(conv.messages.find((m) => m.messageId === draft.draftId)?.status).toBe('sent')
  })

  it('非法 action 40001；重复处置 40901', async () => {
    const bad = await api('/approvals/appr_1/approve', {
      method: 'POST',
      body: JSON.stringify({ action: 'force' }),
    })
    expectFail(bad.json, 40001)

    const repeat = await api('/approvals/appr_1/approve', {
      method: 'POST',
      body: JSON.stringify({ action: 'approve' }),
    })
    expectFail(repeat.json, 40901)
  })
})

describe('POST /approvals/{id}/reject 契约（12 §3.4）', () => {
  it('customer_delete 拒绝：客户解锁（deleteLocked=false）+ rejectReason 留痕', async () => {
    // 先经 CRM 删除流注册新删除审批（跨模块联动 05 §3.3）
    const created = expectOk(
      (
        await api<CustomerDetail>('/customers', {
          method: 'POST',
          body: JSON.stringify({ companyName: 'Reject Flow Co', country: 'US', ownerId: 'u-demo' }),
        })
      ).json,
    )
    const del = await api(`/customers/${created.customerId}`, { method: 'DELETE' })
    expectOk(del.json)

    const pending = expectOk(
      (
        await api<PageResp<ApprovalItem>>('/approvals?type=customer_delete&status=pending&pageSize=50')
      ).json,
    )
    const target = pending.list.find((a) => a.context.customerId === created.customerId)
    expect(target).toBeTruthy()

    const rejected = expectOk(
      (
        await api<{ status: string }>(`/approvals/${target!.approvalId}/reject`, {
          method: 'POST',
          body: JSON.stringify({ reason: '客户信息有误，请核实后重新发起' }),
        })
      ).json,
    )
    expect(rejected.status).toBe('rejected')

    // 解锁回读（客户仍存在 + deleteLocked=false）
    const still = expectOk((await api<CustomerDetail>(`/customers/${created.customerId}`)).json)
    expect(still.deleteLocked).toBe(false)

    const logs = expectOk((await api<ApprovalLog[]>(`/approvals/${target!.approvalId}/logs`)).json)
    expect(logs.at(-1)?.action).toBe('rejected')
    expect(logs.at(-1)?.rejectReason).toBe('客户信息有误，请核实后重新发起')
  })

  it('reason 缺失 42201；expired 单拒绝 42201', async () => {
    const noReason = await api('/approvals/appr_8/reject', {
      method: 'POST',
      body: JSON.stringify({ reason: '  ' }),
    })
    expectFail(noReason.json, 42201)

    const expired = await api('/approvals/appr_2/reject', {
      method: 'POST',
      body: JSON.stringify({ reason: 'late' }),
    })
    expectFail(expired.json, 42201)
  })
})

describe('GET /approvals/{id}/logs 契约（12 §1.5）', () => {
  it('expired 单预置系统留痕日志', async () => {
    const logs = expectOk((await api<ApprovalLog[]>('/approvals/appr_2/logs')).json)
    expect(logs.length).toBeGreaterThan(0)
    expect(logs[0]).toMatchObject({ approvalId: 'appr_2', action: 'expired', approverName: '系统' })
  })

  it('未知审批单 40401', async () => {
    const { json } = await api('/approvals/appr_none/logs')
    expectFail(json, 40401)
  })
})
