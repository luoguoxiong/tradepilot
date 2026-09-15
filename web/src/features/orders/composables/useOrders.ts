import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { useQuery } from '@tanstack/vue-query'

import { getOrderDetail, getOrderSummary, getOrders } from '@/api/resources/orders'
import type { OrderListReq } from '@/api/types/orders'
import { qk } from '@/query/keys'
import { staleTime } from '@/query/options'

/**
 * 10 订单中心数据 hooks：
 * 列表由 ProTable 直接消费 fetchOrders（全量参数进 query key）；此处补充详情 / Tab 计数 / 实时风险。
 */

/** ProTable fetcher：全量参数收窄为订单列表契约（tab/status + customerId + risk + 分页） */
export function fetchOrders(params: Record<string, unknown>) {
  return getOrders(params as OrderListReq)
}

/** 各档 Tab 与风险档数量（10 §1.1；与列表同 invalidate 根 qk.orders.all） */
export function useOrdersSummary() {
  return useQuery({
    queryKey: qk.orders.summary(),
    queryFn: getOrderSummary,
    staleTime: staleTime.DETAIL,
  })
}

/** 订单详情（10 §1.2/§1.3：头 + 进度四要素 + 明细 + 风险洞察 + 变更中审批 + 进度时间线） */
export function useOrderDetail(orderId: MaybeRefOrGetter<string>) {
  return useQuery({
    queryKey: computed(() => qk.orders.detail(toValue(orderId))),
    queryFn: () => getOrderDetail(toValue(orderId)),
    enabled: computed(() => Boolean(toValue(orderId))),
    staleTime: staleTime.DETAIL,
  })
}

/**
 * 履约风险实时评估（10 §3.4）：规则引擎确定性判定，由 OrderRiskPanel 按需显式触发
 * （详情内 riskInsight 为最近一次落库口径，重新评估结果以接口返回覆盖展示）。
 */
