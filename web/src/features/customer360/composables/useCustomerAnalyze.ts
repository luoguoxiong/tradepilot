import { computed, ref, unref, watch, type MaybeRef } from 'vue'
import { useQuery, useQueryClient, type UseQueryReturnType } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'

import { analyzeCustomer } from '@/api/resources/customers'
import { getTask } from '@/api/resources/tasks'
import type { TaskDetail } from '@/api/types/tasks'
import type { ApiError } from '@/api/http'
import { handleApiError } from '@/api/error-handler'
import { qk } from '@/query/keys'
import { isTerminalStatus, taskQueryOptions } from '@/query/options'

/**
 * useCustomerAnalyze —— 客户 360°「AI 分析」异步任务（04 §3.3）：
 * POST /customers/{id}/analyze → taskId → 弹层内轮询任务详情（running 3s/次）；
 * 终态后 invalidate 洞察/产品/联系人（scope=full 会精化联系人决策影响力）并提示完成。
 * 头部 CTA 与 AI Insights 页签「重新分析」共用本逻辑。
 */
export function useCustomerAnalyze(entityId: MaybeRef<string | undefined>) {
  const queryClient = useQueryClient()

  const taskId = ref('')
  const dialogVisible = ref(false)
  const running = ref(false)

  const taskQuery: UseQueryReturnType<TaskDetail, ApiError> = useQuery({
    queryKey: computed(() => qk.tasks.detail(taskId.value)),
    queryFn: () => getTask(taskId.value),
    enabled: computed(() => Boolean(taskId.value) && dialogVisible.value),
    // 轮询节奏从 query 缓存读 status：避免初始化期同步自引用（TDZ ReferenceError）
    ...taskQueryOptions(() => {
      const cached = queryClient.getQueryData<TaskDetail>(qk.tasks.detail(taskId.value))
      return cached?.status
    }),
  })

  watch(
    () => taskQuery.data.value?.status,
    (status) => {
      if (!status) return
      if (isTerminalStatus(status)) {
        running.value = false
        const detail = taskQuery.data.value
        if (status === 'completed') {
          ElMessage.success(detail?.title ? `${detail.title} ✓` : '分析完成')
          invalidate()
          // 成功完成后自动收起进度弹层；失败/取消保留供查看错误（手动确认）
          close()
        } else if (detail?.error) {
          ElMessage.error(detail.error)
        }
      }
    },
  )

  function invalidate() {
    const id = unref(entityId)
    if (!id) return
    void queryClient.invalidateQueries({ queryKey: qk.customer360.insight(id) })
    void queryClient.invalidateQueries({ queryKey: qk.customer360.products(id) })
    void queryClient.invalidateQueries({ queryKey: qk.customer360.contacts(id, undefined) })
  }

  async function run(scope: 'overview' | 'full' = 'full') {
    const id = unref(entityId)
    if (!id || running.value) return
    running.value = true
    dialogVisible.value = true
    try {
      const resp = await analyzeCustomer(id, { scope })
      taskId.value = resp.taskId
    } catch (error) {
      running.value = false
      handleApiError(error, { fallback: '分析任务创建失败' })
    }
  }

  function close() {
    dialogVisible.value = false
    taskId.value = ''
    running.value = false
  }

  return {
    task: taskQuery,
    dialogVisible,
    running,
    run,
    close,
  }
}
