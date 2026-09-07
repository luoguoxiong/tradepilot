import { nextId } from './db'
import { ago } from './conversations'
import {
  customerCompanyNames,
  findCustomer,
  mockCustomers,
  pushActivity,
} from './customers'
import { markMessageRejected, markMessageSent } from './conversations'
import type {
  ApprovalContext,
  ApprovalItem,
  ApprovalLog,
  ApprovalStatus,
  ApprovalType,
  RiskLevel,
} from '@/api/types/approvals'

/**
 * M5 审批 mock 数据源（12 接口文档；12 §5.3 mock 即契约）：
 * - mockApprovals 为待审列表唯一事实源，summary/customer_delete 计数由其派生；
 * - CRM 删除流（handlers/customers.ts）经 registerCustomerDeleteApproval 注册审批单；
 * - 06 send 分支 B 经 registerEmailSendApproval 注册；approve 回调原业务动作（12 §3.3）：
 *   email_send → 会话消息置 sent；customer_delete → 从客户册真删；
 * - reject：customer_delete 解锁（deleteLocked=false），reason 回流 AI 员工反馈闭环。
 */

/** 内部扩展字段（不属 12 §1.2 契约字段，回调原业务动作的定位依据） */
interface MockApproval extends ApprovalItem {
  /** email_send 回调定位：会话 + 草稿消息 */
  linkedConversationId?: string
  linkedMessageId?: string
}

/** 风险分级（12 §7.1：high=quote/contract/customer_delete 一律人工审；medium=email_send 等） */
function riskLevelOf(approvalType: ApprovalType): RiskLevel {
  return approvalType === 'quote' || approvalType === 'contract' || approvalType === 'customer_delete'
    ? 'high'
    : 'medium'
}

const APPROVER = '演示管理员'

export const mockApprovals: MockApproval[] = [
  {
    approvalId: 'appr_1',
    approvalType: 'email_send',
    riskLevel: 'medium',
    title: '邮件发送审核',
    status: 'pending',
    context: {
      conversationId: 'conv_3',
      customerId: 'cus_2',
      contactName: 'Tom Becker',
      subject: 'Re: Pricing structure for 8,000 pairs (CF-Lite)',
      contentPreview:
        'Hi Tom, attached is our tiered price structure for 8,000 pairs split into two shipments: USD 11.90/pair for the first 4,000...',
    },
    aiProposal: {
      emailContent:
        'Hi Tom,\n\nThank you for your transparency on the competing offer. Given the 8,000-pair volume across two shipments, we can offer:\n\n• First 4,000 pairs: USD 11.90/pair\n• Remaining 4,000 pairs: USD 11.60/pair\n• Full-length carbon plate retained; lead time 28 days per shipment\n\nThis keeps our material advantage while staying within 1% of the competitor quote.\n\nBest regards',
    },
    confidence: 0.86,
    reasons: [
      { text: '价格梯度对齐客户竞品报价', evidence: '11.90/11.60 vs 竞品 11.80', source: 'pricing_engine' },
      { text: '高于成本红线，毛利 31%', evidence: '31% ≥ 红线 25%', source: 'pricing_rule' },
      { text: '客户决策影响力高，建议优先跟进', evidence: 'Founder & CEO · 影响力 90', source: 'crm' },
    ],
    citations: [{ docId: 'doc_1', docName: 'Carbon Fiber Catalog.pdf', chunkId: 'chk_8' }],
    createdAt: ago(95),
    expiresAt: ago(-60 * 46),
    linkedConversationId: 'conv_3',
    linkedMessageId: 'msg_12',
  },
  {
    approvalId: 'appr_2',
    approvalType: 'email_send',
    riskLevel: 'medium',
    title: '邮件发送审核',
    status: 'expired',
    context: {
      conversationId: 'conv_6',
      customerId: 'cus_8',
      contactName: 'Felix Braun',
      subject: 'Re: Shipping time to Hamburg',
      contentPreview: 'Dear Felix, sea freight to Hamburg takes 30-34 days including customs...',
    },
    aiProposal: {
      emailContent:
        'Dear Felix,\n\nSea freight to Hamburg takes 30-34 days including customs clearance; air freight 6-8 days door to door.',
    },
    confidence: 0.74,
    reasons: [{ text: '物流时效答复，引用标准时效表', evidence: 'logistics playbook', source: 'knowledge_rag' }],
    createdAt: ago(60 * 24 * 3),
    // 超时终态（Runtime §4.7）：expired 不可再处置，留痕 approval_log.action='expired'
    expiresAt: ago(60),
    approverName: '',
    decidedAt: ago(60),
  },
  {
    approvalId: 'appr_8',
    approvalType: 'customer_delete',
    riskLevel: 'high',
    title: '客户删除审核',
    status: 'pending',
    context: {
      customerId: 'cus_8',
      customerName: 'Aurora Trading',
      relatedCounts: { quotes: 0, orders: 0 },
    },
    aiProposal: {},
    confidence: 0.81,
    reasons: [
      { text: '发起人确认客户重复录入', evidence: '与 Aurora Handels GmbH 重复', source: 'crm' },
    ],
    createdAt: ago(60 * 20),
    expiresAt: ago(-60 * 27),
  },
]

/** 审核留痕（12 §1.5）：approvalId → logs */
export const mockApprovalLogs: Record<string, ApprovalLog[]> = {
  appr_2: [
    {
      logId: 'log_1',
      approvalId: 'appr_2',
      approverName: '系统',
      decidedAt: ago(60),
      action: 'expired',
    },
  ],
}

function pendingCount(approvalType: ApprovalType): number {
  return mockApprovals.filter((a) => a.approvalType === approvalType && a.status === 'pending').length
}

/** summary 计数派生（customer_delete 与 CRM 删除锁定态经由注册/解锁保持同源） */
export function approvalPendingCounts(): { type: ApprovalType | 'all'; count: number }[] {
  const emailSend = pendingCount('email_send')
  const customerDelete = pendingCount('customer_delete')
  return [
    { type: 'all', count: emailSend + customerDelete },
    { type: 'email_send', count: emailSend },
    { type: 'customer_delete', count: customerDelete },
  ]
}

function appendLog(approvalId: string, entry: Omit<ApprovalLog, 'logId' | 'approvalId'>): void {
  mockApprovalLogs[approvalId] = [...(mockApprovalLogs[approvalId] ?? []), { logId: nextId('log'), approvalId, ...entry }]
}

/** 06 send 分支 B 注册邮件发送审批（context/aiProposal 见 12 §1.3） */
export function registerEmailSendApproval(input: {
  conversationId: string
  customerId: string
  customerName: string
  contactName: string
  subject: string
  content: string
  messageId: string
}): string {
  const approvalId = nextId('appr')
  mockApprovals.push({
    approvalId,
    approvalType: 'email_send',
    riskLevel: riskLevelOf('email_send'),
    title: '邮件发送审核',
    status: 'pending',
    context: {
      conversationId: input.conversationId,
      customerId: input.customerId,
      contactName: input.contactName,
      subject: input.subject,
      contentPreview: input.content.slice(0, 120),
    },
    aiProposal: { emailContent: input.content },
    confidence: 0.85,
    reasons: [
      { text: '按企业审批策略，外发邮件需人工审核', evidence: 'email_send = medium', source: 'approval_rule' },
      { text: '内容来自 AI 草稿且经人工编辑', evidence: '编辑差异已留存', source: 'draft_edit' },
    ],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
    linkedConversationId: input.conversationId,
    linkedMessageId: input.messageId,
  })
  return approvalId
}

/** CRM 删除流注册删除审批：锁定客户 + 生成审批单（05 §3.3 → 12） */
export function registerCustomerDeleteApproval(customerId: string): string | null {
  const customer = findCustomer(customerId)
  if (!customer) return null
  const approvalId = nextId('appr')
  mockApprovals.push({
    approvalId,
    approvalType: 'customer_delete',
    riskLevel: riskLevelOf('customer_delete'),
    title: '客户删除审核',
    status: 'pending',
    context: {
      customerId: customer.customerId,
      customerName: customer.companyName,
      relatedCounts: { quotes: 0, orders: 0 },
    },
    aiProposal: {},
    confidence: 0.8,
    reasons: [{ text: '人工发起删除请求，等待审核确认', evidence: `发起人：${customer.ownerName}`, source: 'crm' }],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
  })
  return approvalId
}

/** 审批详情脱内联扩展字段（MockApproval → ApprovalItem 契约形状） */
export function toApprovalItem(record: MockApproval): ApprovalItem {
  const item = { ...record }
  delete item.linkedConversationId
  delete item.linkedMessageId
  return item
}

export type ResolveAction = 'approved' | 'edited_approved' | 'rejected'

/**
 * 审批处置落地（12 §3.3/§3.4 + Runtime §4.7）：
 * - 返回错误码：expired → 42201（超时终态）；非 pending → 40901（重复处置）；
 * - approved/edited_approved 回调原业务动作；rejected 走反馈闭环 + customer_delete 解锁。
 */
export function resolveApproval(
  approvalId: string,
  action: ResolveAction,
  payload: { editedContent?: { aiProposal: Record<string, unknown> }; rejectReason?: string } = {},
): { code: 'ok' | 40901 | 42201; record?: MockApproval } {
  const record = mockApprovals.find((a) => a.approvalId === approvalId)
  if (!record) return { code: 40901 }
  if (record.status === 'expired') return { code: 42201 }
  if (record.status !== 'pending') return { code: 40901 }

  const decidedAt = new Date().toISOString()
  record.decidedAt = decidedAt
  record.approverName = APPROVER

  if (action === 'rejected') {
    record.status = 'rejected' satisfies ApprovalStatus
    record.rejectReason = payload.rejectReason ?? ''
    appendLog(approvalId, {
      approverName: APPROVER,
      decidedAt,
      action: 'rejected',
      rejectReason: payload.rejectReason ?? '',
    })
    if (record.approvalType === 'email_send' && record.linkedConversationId && record.linkedMessageId) {
      // 拒绝后消息退回草稿态，可编辑重发（12 §3.4 反馈闭环）
      markMessageRejected(record.linkedConversationId, record.linkedMessageId)
    }
    if (record.approvalType === 'customer_delete') {
      const customer = findCustomer(record.context.customerId)
      if (customer) customer.deleteLocked = false
    }
    return { code: 'ok', record }
  }

  // approved / edited_approved：回调原业务动作
  record.status = action
  if (record.approvalType === 'email_send') {
    if (record.linkedConversationId && record.linkedMessageId) {
      markMessageSent(record.linkedConversationId, record.linkedMessageId)
    }
    pushActivity({
      type: 'email',
      summary: `邮件发送审批通过：${isEmailSendContext(record.context) ? record.context.subject : ''}`,
      customerId: record.context.customerId,
      customerName: customerNameOf(record),
      operatorType: 'user',
      operatorName: APPROVER,
      refType: 'message',
      refId: record.linkedMessageId ?? null,
    })
  }
  if (record.approvalType === 'customer_delete') {
    const customerId = record.context.customerId
    const customer = findCustomer(customerId)
    if (customer) {
      const index = mockCustomers.indexOf(customer)
      if (index >= 0) mockCustomers.splice(index, 1)
      customerCompanyNames.delete(customer.companyName.toLowerCase())
      pushActivity({
        type: 'note',
        summary: `客户「${customer.companyName}」经审核批准删除`,
        customerId: null,
        customerName: customer.companyName,
        operatorType: 'user',
        operatorName: APPROVER,
      })
    }
  }
  // edited_approved：编辑留痕（12 §1.4：长文本整体替换留痕，v0.1 口径）
  const editedDiff: ApprovalLog['editedDiff'] = []
  if (action === 'edited_approved' && payload.editedContent?.aiProposal) {
    for (const [field, after] of Object.entries(payload.editedContent.aiProposal)) {
      const before = record.aiProposal[field]
      if (typeof after === 'string' && typeof before === 'string' && before !== after) {
        editedDiff.push({ field: `aiProposal.${field}`, before, after })
        record.aiProposal[field] = after
      }
    }
  }
  appendLog(approvalId, {
    approverName: APPROVER,
    decidedAt,
    action,
    ...(editedDiff.length ? { editedDiff } : {}),
  })
  return { code: 'ok', record }
}

function customerNameOf(record: MockApproval): string {
  if ('customerName' in record.context) return record.context.customerName
  return findCustomer(record.context.customerId)?.companyName ?? ''
}

/** 详情查询（含脱内联字段）；未命中返回 null */
export function findApprovalItem(approvalId: string): ApprovalItem | null {
  const record = mockApprovals.find((a) => a.approvalId === approvalId)
  return record ? toApprovalItem(record) : null
}

/** 类型收窄：email_send 上下文 */
export function isEmailSendContext(context: ApprovalContext): context is ApprovalContext & {
  conversationId: string
  customerId: string
  contactName: string
  subject: string
  contentPreview: string
} {
  return 'conversationId' in context
}
