import type { PageReq, PageResp } from '@/api/types/common'

/** 订单状态（10 §1.2 sales_order.status，由进度四要素推导，决策 A3） */
export type OrderStatus = 'pending_payment' | 'in_production' | 'ready_to_ship' | 'completed'

/** 列表 Tab（10 §1.1：all + 四状态） */
export type OrderTab = 'all' | OrderStatus

/** 履约风险徽标（10 §1.2 risk，规则引擎判定） */
export type OrderRisk = 'normal' | 'at_risk'

/** 成本项（10 §1.3 五项成本快照，与报价同口径） */
export type OrderCostItemKey = 'purchase' | 'freight' | 'insurance' | 'tax' | 'fx'

/** 进度四要素（10 §1.2 progress） */
export interface OrderProgress {
  poConfirmed: boolean
  payment: boolean
  productionPct: number
  shipping: boolean
}

/** 风险建议类型：internal 内部任务 / customer 客户沟通（10 §3.5） */
export type OrderSuggestionType = 'internal' | 'customer'

/** 风险建议项 */
export interface OrderRiskSuggestion {
  suggestionId: string
  type: OrderSuggestionType
  label: string
}

/** 风险证据（规则引擎口径：计划/实际进度、计划来源与阈值，10 §1.3） */
export interface OrderRiskEvidence {
  plannedPct?: number
  actualPct?: number
  /** 计划进度口径（决策 A4 固定 linear_by_time） */
  planSource?: string
  /** 落后阈值（百分点，决策 A5） */
  thresholdPct?: number
  [key: string]: unknown
}

/** 风险视图（详情 riskInsight / 独立评估接口同结构） */
export interface OrderRiskView {
  risk: OrderRisk | string
  delayDays: number
  reason: string
  evidence: OrderRiskEvidence
  suggestions: OrderRiskSuggestion[]
  confidence: number | null
  generatedAt: string
  source: string
}

/** 列表行（10 §2 GET /orders） */
export interface OrderListItem {
  orderId: string
  orderNo: string
  customerId: string
  customerName: string
  amount: string
  currency: string
  status: OrderStatus | string
  risk: OrderRisk | string
  deliveryDate: string
  createdAt: string
}

/** 各档 Tab 数量 */
export interface OrderListCounts {
  all?: number
  pending_payment?: number
  in_production?: number
  ready_to_ship?: number
  completed?: number
}

/** 风险档数量 */
export interface OrderRiskCounts {
  normal?: number
  at_risk?: number
}

/** 列表响应（分页 + Tab/风险计数） */
export interface OrderListResp extends PageResp<OrderListItem> {
  counts: OrderListCounts
  riskCounts: OrderRiskCounts
}

/** 列表查询参数（tab 与 status 二选一，tab 优先） */
export interface OrderListReq extends PageReq {
  tab?: OrderTab
  status?: OrderStatus
  customerId?: string
  risk?: OrderRisk
}

/** 明细行 */
export interface OrderItem {
  productId: string
  productName: string
  quantity: number
  unitPrice: string
  lineTotal: string
  costSnapshot: Partial<Record<OrderCostItemKey, number>>
}

/** 进度流水（时间线） */
export interface OrderTimelineEntry {
  id: string
  productionPct: number
  note: string
  createdAt: string
}

/** 订单详情（10 §1.2） */
export interface OrderDetail {
  orderId: string
  orderNo: string
  status: OrderStatus | string
  risk: OrderRisk | string
  customerId: string
  customerName: string
  customer: { country: string | null; isFormal: boolean } | null
  contactId: string | null
  contact: { name: string; email: string | null } | null
  quotationId: string | null
  deliveryDate: string
  paymentTerms: string | null
  amount: string
  currency: string
  progress: OrderProgress
  items: OrderItem[]
  riskInsight: OrderRiskView | null
  /** 变更审批（order_change 高危动作，10 FR-03） */
  pendingChange: {
    approvalId: string
    title: string
    status: string
    createdAt: string
  } | null
  timeline: OrderTimelineEntry[]
  ownerId: string
  ownerName: string | null
  createdAt: string
  updatedAt: string
}

/** 明细行入参 */
export interface OrderItemPayload {
  productId: string
  quantity: number
  unitPrice: string
  costSnapshot?: Partial<Record<OrderCostItemKey, number>>
}

/** 新建订单入参（fromQuoteId 转单时 items/customerId 可省略，10 §3.1） */
export interface OrderCreateReq {
  deliveryDate: string
  currency?: string
  paymentTerms?: string
  fromQuoteId?: string
  customerId?: string
  items?: OrderItemPayload[]
}

export interface OrderCreateResp {
  orderId: string
  orderNo: string
  status: OrderStatus | string
  fromQuote: boolean
}

/** 变更订单入参（任一字段 → order_change 审批，10 §3.2） */
export interface OrderUpdateReq {
  deliveryDate?: string
  amount?: string
  items?: OrderItemPayload[]
}

/** 变更响应：高危审批已创建，落库待审批通过 */
export interface OrderUpdateResp {
  orderId: string
  approvalId: string
  approvalType: string
  riskLevel: string
  status: string
  changes: Record<string, unknown>
}

/** 更新履约进度入参（部分更新） */
export interface OrderProgressUpdateReq {
  progress: Partial<OrderProgress>
}

export interface OrderProgressUpdateResp {
  orderId: string
  status: OrderStatus | string
  progress: OrderProgress
  risk: { status: string; delayDays: number }
}

/** 风险评估响应（10 §3.4） */
export interface OrderRiskResp extends OrderRiskView {
  orderId: string
  orderNo: string
  customerId: string
}

/** 执行风险建议入参 / 响应（10 §3.5） */
export interface OrderRiskExecuteReq {
  suggestionIds: string[]
}

export interface OrderRiskExecuteResp {
  orderId: string
  taskIds: string[]
  approvalIds: string[]
  draft: { draftId: string; conversationId: string; content: string } | null
}

/** 延期沟通草稿（10 §3.7） */
export interface OrderDraftEmailResp {
  draftId: string
  conversationId: string
  content: string
}

/** Tab/风险计数（10 §1.1 GET /orders/summary） */
export interface OrderSummaryResp {
  tabs: { status: OrderTab | string; count: number }[]
  risks: { risk: OrderRisk | string; count: number }[]
}
