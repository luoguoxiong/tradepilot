import { computed, ref, toValue, type MaybeRefOrGetter } from 'vue'
import { useQuery } from '@tanstack/vue-query'

import { getTask, getTasks } from '@/api/resources/tasks'
import { getEmployees } from '@/api/resources/employees'
import type { TaskListReq } from '@/api/types/tasks'
import { qk } from '@/query/keys'
import { staleTime, taskQueryOptions } from '@/query/options'

/**
 * 14 AI 任务中心数据 hooks：
 * - 列表由 ProTable 直接消费 fetchTasks（全量参数进 query key，status Tab 由 externalQuery 下发）；
 * - 详情供步骤/输入/产出物静态部分使用；实时进度/日志/状态由 useTaskStream 承担（SSE 主链路），
 *   非终态时以 3s 兜底轮询（03 §5.2）。
 */

/** ProTable fetcher：把页面 query 收窄为任务列表契约（避免 scope/sortBy 等透传字段污染请求） */
export function fetchTasks(params: Record<string, unknown>): ReturnType<typeof getTasks> {
  const { status, employeeId, type, keyword, page, pageSize } = params
  return getTasks({
    status: status as TaskListReq['status'],
    employeeId: employeeId as string | undefined,
    type: type as TaskListReq['type'],
    keyword: keyword as string | undefined,
    page: page as number,
    pageSize: pageSize as number,
  })
}

/** 任务详情（14 §1.2）：input/steps/outputs + 头部字段；running 兜底轮询，终态停止 */
export function useTaskDetail(taskId: MaybeRefOrGetter<string>) {
  const lastStatus = ref<string | undefined>()
  return useQuery({
    queryKey: computed(() => qk.tasks.detail(toValue(taskId))),
    queryFn: async () => {
      const detail = await getTask(toValue(taskId))
      lastStatus.value = detail.status
      return detail
    },
    enabled: computed(() => Boolean(toValue(taskId))),
    ...taskQueryOptions(() => lastStatus.value),
  })
}

/** 员工下拉源（`+ 新任务` 跨员工下发；字典级缓存） */
export function useEmployeeOptions() {
  return useQuery({
    queryKey: qk.employees.list(),
    queryFn: getEmployees,
    staleTime: staleTime.DICT,
  })
}
