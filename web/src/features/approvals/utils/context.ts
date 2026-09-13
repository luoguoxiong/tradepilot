import type { ApprovalContext, OrderChangeContext, QuoteContext } from '@/api/types/approvals'

/** 类型收窄：email_send 上下文（12 §1.3，卡片/详情差异化渲染） */
export function isEmailSendContext(context: ApprovalContext): context is ApprovalContext & {
  conversationId: string
  customerId: string
  contactName: string
  subject: string
  contentPreview: string
} {
  return 'conversationId' in context
}

/** 类型收窄：customer_delete 上下文 */
export function isCustomerDeleteContext(context: ApprovalContext): context is ApprovalContext & {
  customerId: string
  customerName: string
  relatedCounts: { quotes: number; orders: number }
} {
  return 'customerName' in context
}

/** 类型收窄：quote 上下文（12 §1.3 / 09 §3.3，D10 报价 Tab 卡片渲染） */
export function isQuoteContext(context: ApprovalContext): context is QuoteContext {
  return 'quoteNo' in context
}

/** 类型收窄：order_change 上下文（12 §1.3 / 10 FR-03，D10 订单变更 Tab 卡片渲染） */
export function isOrderChangeContext(context: ApprovalContext): context is OrderChangeContext {
  return 'orderNo' in context
}
