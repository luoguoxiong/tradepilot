import type { InsightCitation, InsightReason } from '@/api/types/insight'

/**
 * 12 AI 审核中心接口契约（12 接口文档 v0.2 §1/§2/§3）。
 * P0 实际审批来源 = email_send + customer_delete（D10，00 §5.1）；
 * quote/order_change/contract/bulk_marketing 类型随 P1 模块启用。
 */

/** 审批类型（12 §7.1；P0 实际审批来源 = email_send + customer_delete） */
export type ApprovalType =
  | 'quote'
  | 'email_send'
  | 'contract'
  | 'order_change'
  | 'bulk_marketing'
  | 'customer_delete'

/** GET /approvals/summary 响应（接口文档 12 §3.1）：Tab 待审数，notifyStore 轮询数据源 */
export interface ApprovalSummary {
  tabs: { type: ApprovalType | 'all'; count: number }[]
}

/** 风险等级（12 §1.2：high 永远人工审 / medium 可配自动通过 / low 不进审批中心） */
export type RiskLevel = 'high' | 'medium' | 'low'

/** 审批状态（12 §1.2；expired 超时终态 / auto_approved 自动通过留痕，工程约定） */
export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'edited_approved'
  | 'rejected'
  | 'expired'
  | 'auto_approved'

/** email_send 上下文（12 §1.3） */
export interface EmailSendContext {
  conversationId: string
  customerId: string
  contactName: string
  subject: string
  contentPreview: string
}

/** customer_delete 上下文（12 §1.3） */
export interface CustomerDeleteContext {
  customerId: string
  customerName: string
  relatedCounts: { quotes: number; orders: number }
}

/** context 按 approvalType 差异化（12 §1.3；P0 收敛两形，其余类型 P1 启用） */
export type ApprovalContext = EmailSendContext | CustomerDeleteContext

/** 审批列表行 / 详情卡片（12 §1.2 全字段） */
export interface ApprovalItem {
  approvalId: string
  approvalType: ApprovalType
  riskLevel: RiskLevel
  title: string
  status: ApprovalStatus
  context: ApprovalContext
  aiProposal: {
    /** email_send：完整邮件正文（编辑后批准预填 DraftEditor） */
    emailContent?: string
    /** 其余类型建议字段原样透传（如 suggestedUnitPrice） */
    [key: string]: unknown
  }
  /** 置信度 0~1（进度条，禁止虚构） */
  confidence: number
  reasons: InsightReason[]
  citations?: InsightCitation[]
  createdAt: string
  /** 超时时间（按类型默认 48h，16 可配；超时 → expired 终态） */
  expiresAt?: string
  /** 已处置时间 */
  decidedAt?: string
  approverName?: string
  rejectReason?: string
}

/** POST /approvals/{id}/approve 请求二选一（12 §3.3） */
export type ApproveReq =
  | { action: 'approve' }
  | {
      action: 'edited_approved'
      /** 编辑后内容（email_send：{ aiProposal: { emailContent } }），生成 editedDiff 留痕 */
      editedContent: { aiProposal: Record<string, unknown> }
    }

/** approve 响应：服务端回调原业务动作后的结果引用（12 §3.3） */
export interface ApproveResp {
  approvalId: string
  status: ApprovalStatus
  resultRef?: Record<string, unknown>
}

/** POST /approvals/{id}/reject（12 §3.4：reason 必填，缺失 42201） */
export interface RejectReq {
  reason: string
}

/** 审核留痕（12 §1.5） */
export interface ApprovalLog {
  logId: string
  approvalId: string
  approverName: string
  decidedAt: string
  /** action 含 auto_approved/expired 留痕（工程约定） */
  action: 'approved' | 'edited_approved' | 'rejected' | 'expired' | 'auto_approved'
  /** 编辑留痕：字段级 before/after（长文本 v0.1 整体替换留痕） */
  editedDiff?: { field: string; before: string; after: string }[]
  rejectReason?: string
}

/** GET /approvals 查询参数（12 §3.2） */
export interface ApprovalListReq {
  type?: ApprovalType | 'all'
  status?: ApprovalStatus | 'processed'
  page?: number
  pageSize?: number
}
