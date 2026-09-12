import { QueryCache, QueryClient } from '@tanstack/vue-query'

import { handleApiError } from '@/api/error-handler'

/**
 * 全局 QueryClient（03 §5）。
 * staleTime 契约：列表 10s / 详情 30s / 聚合 30s / 审批 15s / 字典 10min，各 query 自行覆写。
 * queryCache.onError：查询层兜底——列表/详情请求失败统一走错误码管道（03 §4），
 * 40301 列表由 ProTable 渲染空态、50001 弹全局通知 + traceId；个别 query 自管错误时置
 * `meta: { silentError: true }` 跳过（如轮询静默降级场景）。
 */
export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (query.meta?.silentError) return
      handleApiError(error)
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
})
