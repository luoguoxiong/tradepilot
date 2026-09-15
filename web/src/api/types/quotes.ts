import type { PageReq, PageResp } from '@/api/types/common'
import type { InsightReason } from '@/api/types/insight'

/** 报价状态（接口规范 §3.6 / 需求 09 §1.2 quote_status） */
export type QuoteStatus = 'draft' | 'waiting_approval' | 'sent' | 'won' | 'lost'

/** 列表 Tab（09 §1.1：all + 五个状态） */
export type QuoteTab = 'all' | QuoteStatus

/** 失效原因（09 §3.7 lostReason，选填） */
export type QuoteLostReason = 'price' | 'no_response' | 'competitor' | 'timing' | 'other'

/** 成本项（09 §1.3 五项成本快照） */
export type QuoteCostItemKey = 'purchase' | 'freight' | 'insurance' | 'tax' | 'fx'

/** 成本快照 / 报价级成本汇总 */
export type QuoteCostSnapshot = Partial<Record<QuoteCostItemKey, number>>
export type QuoteCostBreakdown = Record<QuoteCostItemKey, string>

/** 汇率快照（09 §1.2，报价头结构化字段） */
export interface QuoteExchangeRate {
  rate: string
  date: string
  source: string
}

/** 列表行（09 §2 GET /quotes） */
export interface QuoteListItem {
  quoteId: string
  quoteNo: string
  customerId: string
  customerName: string
  totalAmount: string
  currency: string
  status: QuoteStatus
  createdAt: string
}

/** 各档 Tab 数量（09 §1.1） */
export interface QuoteListCounts {
  all: number
  draft: number
  waiting_approval: number
  sent: number
  won: number
  lost: number
}

/** 列表响应（分页 + 各档数量） */
export interface QuoteListResp extends PageResp<QuoteListItem> {
  counts: QuoteListCounts
}

/** 列表查询参数 */
export interface QuoteListReq extends PageReq {
  status?: QuoteStatus
  customerId?: string
}

/** 明细行（09 §1.3） */
export interface QuoteItem {
  productId: string
  productName: string
  quantity: number
  unitPrice: string
  lineTotal: string
  costSnapshot: QuoteCostSnapshot
}

/** 报价详情（09 §1.2/§1.3） */
export interface QuoteDetail {
  quoteId: string
  quoteNo: string
  status: QuoteStatus
  customerId: string
  customerName: string
  customer: { score: number | null; isFormal: boolean; country: string | null } | null
  contactId: string | null
  contact: { name: string; email: string | null } | null
  currency: string
  incoterms: string
  validUntil: string
  exchangeRate: QuoteExchangeRate
  paymentTerms: string
  totalAmount: string
  profitMarginPct: number | null
  costBreakdown: QuoteCostBreakdown
  aiPricing: { costBreakdown?: QuoteCostBreakdown } | null
  items: QuoteItem[]
  approval: { approvalId: string; status: string; riskLevel: string } | null
  ownerId: string
  ownerName: string | null
  sentAt: string | null
  wonAt: string | null
  lostReason: string | null
  createdAt: string
  updatedAt: string
}

/** 明细行入参（costSnapshot 为 draft 态人工覆盖，值统一字符串） */
export interface QuoteItemPayload {
  productId: string
  quantity: number
  unitPrice: string
  costSnapshot?: Partial<Record<QuoteCostItemKey, string>>
}

/** 新建 / 编辑入参（09 §3.1；编辑为局部更新） */
export interface QuoteUpsertReq {
  customerId: string
  contactId?: string
  currency: string
  incoterms: string
  validUntil: string
  paymentTerms: string
  exchangeRate?: { rate: string; date?: string; source?: string }
  items: QuoteItemPayload[]
}

export type QuoteUpdateReq = Partial<QuoteUpsertReq>

/** 新建响应 */
export interface QuoteCreateResp {
  quoteId: string
  quoteNo: string
  status: QuoteStatus
}

/** AI 定价建议入参 / 响应（09 §3.2） */
export interface QuoteAiPricingReq {
  productId?: string
  quantity?: number
  unitPrice?: string
}

export interface QuoteAiPricingResp {
  suggestedUnitPrice: string
  profitMarginPct: number
  costBreakdown: QuoteCostBreakdown
  reasons: InsightReason[]
}

/** 议价梯度（09 §3.8；绝不返回底价/剩余底线） */
export interface QuoteNegotiationLadderResp {
  ladder: { round: number; discountPct: number; suggestedUnitPrice: string }[]
  source: string
}

/** 状态流转响应 */
export interface QuoteSubmitResp {
  quoteId: string
  status: QuoteStatus
  approval: { approvalId: string; approvalType: string; riskLevel: string; status: string }
}

export interface QuoteSendResp {
  status: QuoteStatus
  sentAt: string
}

export interface QuoteMarkWonResp {
  status: QuoteStatus
  wonAt: string
  customerUpgraded: boolean
}

export interface QuoteMarkLostResp {
  status: QuoteStatus
  lostAt: string
  lostReason?: string
}

export interface QuoteReviveResp {
  status: QuoteStatus
}

/** Tab 计数（09 §1.1 GET /quotes/summary） */
export interface QuoteSummaryResp {
  tabs: { status: QuoteTab; count: number }[]
}
