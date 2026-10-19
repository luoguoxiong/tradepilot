import { http, request } from '@/api/http'
import type { QuoteListReq } from '@/api/types/quotes'
import type {
  QuoteAiPricingReq,
  QuoteAiPricingResp,
  QuoteCreateResp,
  QuoteDetail,
  QuoteListResp,
  QuoteMarkLostResp,
  QuoteMarkWonResp,
  QuoteNegotiationLadderResp,
  QuoteReviveResp,
  QuoteSendResp,
  QuoteSubmitResp,
  QuoteSummaryResp,
  QuoteUpdateReq,
  QuoteUpsertReq,
} from '@/api/types/quotes'

/**
 * 报价中心接口封装（接口文档 09 §2/§3，P1）。
 * 列表/详情走 request（envelope 解包）；PDF 导出为二进制流，走 http 原始响应。
 */

/** 09 §2 报价列表（status Tab + keyword=编号/客户名，分页；含各档数量） */
export function getQuotes(params: QuoteListReq): Promise<QuoteListResp> {
  return request<QuoteListResp>({ url: '/quotes', method: 'get', params })
}

/** 09 §1.1 各档 Tab 数量 */
export function getQuoteSummary(): Promise<QuoteSummaryResp> {
  return request<QuoteSummaryResp>({ url: '/quotes/summary', method: 'get' })
}

/** 09 §1.2/§1.3 报价详情 */
export function getQuoteDetail(quoteId: string): Promise<QuoteDetail> {
  return request<QuoteDetail>({ url: `/quotes/${quoteId}`, method: 'get' })
}

/** 09 §3.1 新建报价 */
export function createQuote(payload: QuoteUpsertReq): Promise<QuoteCreateResp> {
  return request<QuoteCreateResp>({ url: '/quotes', method: 'post', data: payload })
}

/** 09 §2 编辑报价（仅 draft） */
export function updateQuote(quoteId: string, payload: QuoteUpdateReq): Promise<QuoteCreateResp> {
  return request<QuoteCreateResp>({ url: `/quotes/${quoteId}`, method: 'put', data: payload })
}

/** 09 §3.2 获取 AI 定价建议（只读） */
export function fetchQuoteAiPricing(
  quoteId: string,
  payload: QuoteAiPricingReq = {},
): Promise<QuoteAiPricingResp> {
  return request<QuoteAiPricingResp>({
    url: `/quotes/${quoteId}/ai-pricing`,
    method: 'post',
    data: payload,
  })
}

/** 09 §3.3 提交审核 */
export function submitQuote(quoteId: string): Promise<QuoteSubmitResp> {
  return request<QuoteSubmitResp>({ url: `/quotes/${quoteId}/submit`, method: 'post' })
}

/** 09 §3.4 发送报价（须关联审批通过） */
export function sendQuote(quoteId: string): Promise<QuoteSendResp> {
  return request<QuoteSendResp>({ url: `/quotes/${quoteId}/send`, method: 'post' })
}

/** 09 §3.5 标记成交 */
export function markQuoteWon(quoteId: string): Promise<QuoteMarkWonResp> {
  return request<QuoteMarkWonResp>({ url: `/quotes/${quoteId}/mark-won`, method: 'post' })
}

/** 09 §3.7 标记失效 */
export function markQuoteLost(
  quoteId: string,
  payload: { reason?: string } = {},
): Promise<QuoteMarkLostResp> {
  return request<QuoteMarkLostResp>({
    url: `/quotes/${quoteId}/mark-lost`,
    method: 'post',
    data: payload,
  })
}

/** 09 §3.7 复活失效报价（lost → draft） */
export function reviveQuote(quoteId: string): Promise<QuoteReviveResp> {
  return request<QuoteReviveResp>({ url: `/quotes/${quoteId}/revive`, method: 'post' })
}

/** 09 §3.8 议价梯度建议（只读） */
export function getQuoteNegotiationLadder(quoteId: string): Promise<QuoteNegotiationLadderResp> {
  return request<QuoteNegotiationLadderResp>({
    url: `/quotes/${quoteId}/negotiation-ladder`,
    method: 'get',
  })
}

/** 09 §3.6 导出报价单 PDF（服务端渲染；触发浏览器下载） */
export async function downloadQuotePdf(quoteId: string, filename: string): Promise<void> {
  const response = await http.get(`/quotes/${quoteId}/pdf`, { responseType: 'blob' })
  const url = URL.createObjectURL(response.data as Blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
