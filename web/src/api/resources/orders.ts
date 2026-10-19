import { request } from '@/api/http'
import type {
  OrderCreateReq,
  OrderCreateResp,
  OrderDetail,
  OrderDraftEmailResp,
  OrderListReq,
  OrderListResp,
  OrderProgressUpdateReq,
  OrderProgressUpdateResp,
  OrderRiskExecuteReq,
  OrderRiskExecuteResp,
  OrderRiskResp,
  OrderSummaryResp,
  OrderUpdateReq,
  OrderUpdateResp,
} from '@/api/types/orders'

/**
 * 订单中心接口封装（接口文档 10 §1/§2/§3，P1）。
 * 金额/交期/数量变更不直接落库：PUT /orders/{id} 返回 order_change 审批信息（10 §4 AI 边界）。
 */

/** 10 §2 订单列表（tab/status + customerId + risk 筛选，分页；含 Tab 与风险计数） */
export function getOrders(params: OrderListReq): Promise<OrderListResp> {
  return request<OrderListResp>({ url: '/orders', method: 'get', params })
}

/** 10 §1.1 各档 Tab 与风险档数量 */
export function getOrderSummary(): Promise<OrderSummaryResp> {
  return request<OrderSummaryResp>({ url: '/orders/summary', method: 'get' })
}

/** 10 §1.2/§1.3 订单详情 */
export function getOrderDetail(orderId: string): Promise<OrderDetail> {
  return request<OrderDetail>({ url: `/orders/${orderId}`, method: 'get' })
}

/** 10 §3.1 创建订单（fromQuoteId 转单 / 手工建单） */
export function createOrder(payload: OrderCreateReq): Promise<OrderCreateResp> {
  return request<OrderCreateResp>({ url: '/orders', method: 'post', data: payload })
}

/** 10 §3.2 变更订单（交期/金额/明细 → order_change 高危审批） */
export function updateOrder(orderId: string, payload: OrderUpdateReq): Promise<OrderUpdateResp> {
  return request<OrderUpdateResp>({ url: `/orders/${orderId}`, method: 'put', data: payload })
}

/** 10 §3.3 更新履约进度（状态由进度四要素推导 + 风险自动评估） */
export function updateOrderProgress(
  orderId: string,
  payload: OrderProgressUpdateReq,
): Promise<OrderProgressUpdateResp> {
  return request<OrderProgressUpdateResp>({
    url: `/orders/${orderId}/progress`,
    method: 'put',
    data: payload,
  })
}

/** 10 §3.4 履约风险评估（规则引擎实时评估） */
export function fetchOrderRisk(orderId: string): Promise<OrderRiskResp> {
  return request<OrderRiskResp>({ url: `/orders/${orderId}/risk`, method: 'get' })
}

/** 10 §3.5 执行风险建议（internal → 建任务；customer → 生成草稿 + 审批） */
export function executeOrderRisk(
  orderId: string,
  payload: OrderRiskExecuteReq,
): Promise<OrderRiskExecuteResp> {
  return request<OrderRiskExecuteResp>({
    url: `/orders/${orderId}/risk/execute`,
    method: 'post',
    data: payload,
  })
}

/** 10 §3.7 生成延期沟通草稿（进入会话草稿箱，须人工确认后发送） */
export function draftOrderDelayEmail(orderId: string): Promise<OrderDraftEmailResp> {
  return request<OrderDraftEmailResp>({
    url: `/orders/${orderId}/draft-email`,
    method: 'post',
  })
}
