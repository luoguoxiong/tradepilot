import { keepPreviousData } from '@tanstack/vue-query'

/**
 * staleTime 契约（03 §5.2）：与 query/client.ts 默认值（列表 10s）配套，
 * 各 query 按数据时效选档，禁止页面内随意覆写魔法数字。
 */
export const staleTime = {
  /** 列表页（筛选变更即新 key，缓存保留可回退） */
  LIST: 10_000,
  /** 详情 / 聚合口径 */
  DETAIL: 30_000,
  /** 审批队列 / 待审数（高时效） */
  APPROVAL: 15_000,
  /** 字典 / 枚举 / 员工列表 / 角色模板 */
  DICT: 600_000,
  /** 任务详情（running 非 SSE 场景兜底轮询节奏） */
  TASK_RUNNING: 3_000,
} as const

/**
 * 列表 query 通用选项：keepPreviousData 防筛选/翻页时表格抖动（03 §5.2 / 02 §4.1）。
 * 用法：useQuery({ queryKey, queryFn, ...listQueryOptions })
 */
export function listQueryOptions() {
  return {
    staleTime: staleTime.LIST,
    placeholderData: keepPreviousData,
  }
}

/** 任务 query 选项：running 时 3s 兜底轮询，终态停止（03 §5.2） */
export function taskQueryOptions(status: () => string | null | undefined) {
  return {
    staleTime: staleTime.DETAIL,
    refetchInterval: () => {
      const s = status()
      return s && !isTerminalStatus(s) ? staleTime.TASK_RUNNING : false
    },
  }
}

/** 任务终态（14 §1.1）：completed / failed / canceled；paused 不视为终态（可 resume） */
export function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'canceled'
}
