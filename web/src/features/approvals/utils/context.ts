import type { ApprovalContext } from '@/api/types/approvals'

/** 类型收窄：email_send 上下文（12 §1.3，卡片/详情差异化渲染） */
export function isEmailSendContext(
  context: ApprovalContext,
): context is ApprovalContext & {
  conversationId: string
  customerId: string
  contactName: string
  subject: string
  contentPreview: string
} {
  return 'conversationId' in context
}

/** 类型收窄：customer_delete 上下文 */
export function isCustomerDeleteContext(
  context: ApprovalContext,
): context is ApprovalContext & {
  customerId: string
  customerName: string
  relatedCounts: { quotes: number; orders: number }
} {
  return 'customerName' in context
}
