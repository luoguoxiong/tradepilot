/** 审批类型（12 §7.1；P0 实际审批来源 = email_send + customer_delete） */
export type ApprovalType =
  'quote' | 'email_send' | 'contract' | 'order_change' | 'bulk_marketing' | 'customer_delete'

/** GET /approvals/summary 响应（接口文档 12 §3.1）：Tab 待审数，notifyStore 轮询数据源 */
export interface ApprovalSummary {
  tabs: { type: ApprovalType | 'all'; count: number }[]
}
