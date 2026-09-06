import { QueryClient } from '@tanstack/vue-query'

/**
 * 全局 QueryClient（03 §5）。
 * staleTime 契约：列表 10s / 详情 30s / 聚合 30s / 审批 15s / 字典 10min，各 query 自行覆写。
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
})
