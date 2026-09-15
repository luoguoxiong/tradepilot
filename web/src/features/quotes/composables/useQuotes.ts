import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { useQuery } from '@tanstack/vue-query'

import {
  getQuoteDetail,
  getQuotes,
  getQuoteSummary,
  getQuoteNegotiationLadder,
} from '@/api/resources/quotes'
import type { QuoteListReq } from '@/api/types/quotes'
import { qk } from '@/query/keys'
import { staleTime } from '@/query/options'

/**
 * 09 报价中心数据 hooks：
 * 列表由 ProTable 直接消费 fetchQuotes（全量参数进 query key）；此处补充详情 / Tab 计数。
 */

/** ProTable fetcher：全量参数收窄为报价列表契约（status Tab + keyword） */
export function fetchQuotes(params: Record<string, unknown>) {
  return getQuotes(params as QuoteListReq)
}

/** 各档 Tab 数量（09 §1.1；与列表同 invalidate 根 qk.quotes.all） */
export function useQuotesSummary() {
  return useQuery({
    queryKey: qk.quotes.summary(),
    queryFn: getQuoteSummary,
    staleTime: staleTime.DETAIL,
  })
}

/** 报价详情（09 §1.2/§1.3） */
export function useQuoteDetail(quoteId: MaybeRefOrGetter<string>) {
  return useQuery({
    queryKey: computed(() => qk.quotes.detail(toValue(quoteId))),
    queryFn: () => getQuoteDetail(toValue(quoteId)),
    enabled: computed(() => Boolean(toValue(quoteId))),
    staleTime: staleTime.DETAIL,
  })
}

/**
 * 议价梯度（09 §3.8；只读建议）：16 未配置 discountLadder 时服务端返回空数组，
 * 消费方据此隐藏区块（09 决策 A2）。
 */
export function useQuoteNegotiationLadder(quoteId: MaybeRefOrGetter<string>) {
  return useQuery({
    queryKey: computed(() => qk.quotes.ladder(toValue(quoteId))),
    queryFn: () => getQuoteNegotiationLadder(toValue(quoteId)),
    enabled: computed(() => Boolean(toValue(quoteId))),
    staleTime: staleTime.DETAIL,
  })
}
