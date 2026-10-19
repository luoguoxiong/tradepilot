import { computed, ref, unref, watch, type MaybeRef } from 'vue'
import { useQuery, useQueryClient, type UseQueryReturnType } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'

import { analyzeProduct, generateProductKnowledge } from '@/api/resources/products'
import { getTask } from '@/api/resources/tasks'
import type { TaskDetail, TaskOutput } from '@/api/types/tasks'
import type { ProductKnowledge, ProductKnowledgeSource } from '@/api/types/products'
import type { ApiError } from '@/api/http'
import { handleApiError } from '@/api/error-handler'
import { qk } from '@/query/keys'
import { isTerminalStatus, taskQueryOptions } from '@/query/options'

/** AI 动作分工（08 §3.2/§3.3）：analyze 仅预览不落库 / generate 落库 draft 待确认 */
export type ProductKnowledgeMode = 'analyze' | 'generate'

/**
 * useProductKnowledge —— 产品中心「AI 分析 / AI 生成知识」异步任务（08 §3.2/§3.3）：
 * POST /products/{id}/analyze | /knowledge/generate → taskId → 弹层轮询任务详情（running 3s/次）；
 * 终态后 generate 失效产品详情（knowledge 落库）；analyze 从 task.outputs 取 insight 预览（不落库）。
 */
export function useProductKnowledge(productId: MaybeRef<string | undefined>) {
  const queryClient = useQueryClient()

  const taskId = ref('')
  const dialogVisible = ref(false)
  const running = ref(false)
  const mode = ref<ProductKnowledgeMode>('analyze')

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

  /** analyze 预览：任务 outputs 的 insight 载荷（与 §1.6 同结构，仅展示） */
  const preview = computed<ProductKnowledge | null>(() => {
    const outputs = taskQuery.data.value?.outputs as TaskOutput[] | null | undefined
    const insight = outputs?.find((o) => o.type === 'insight')
    return insight ? (insight.payload as ProductKnowledge) : null
  })

  watch(
    () => taskQuery.data.value?.status,
    (status) => {
      if (!status) return
      if (isTerminalStatus(status)) {
        running.value = false
        const detail = taskQuery.data.value
        if (status === 'completed') {
          ElMessage.success(
            mode.value === 'generate' ? '产品知识已生成（待确认）' : 'AI 分析已完成',
          )
          if (mode.value === 'generate') {
            void queryClient.invalidateQueries({ queryKey: qk.products.all })
          }
        } else if (detail?.error) {
          ElMessage.error(detail.error)
        }
      }
    },
  )

  async function run(nextMode: ProductKnowledgeMode, sources: ProductKnowledgeSource[]) {
    const id = unref(productId)
    if (!id || running.value) return
    mode.value = nextMode
    running.value = true
    dialogVisible.value = true
    try {
      const resp =
        nextMode === 'generate'
          ? await generateProductKnowledge(id, { sources })
          : await analyzeProduct(id, { sources })
      taskId.value = resp.taskId
    } catch (error) {
      running.value = false
      handleApiError(error, { fallback: '任务创建失败' })
    }
  }

  function close() {
    dialogVisible.value = false
    taskId.value = ''
    running.value = false
  }

  return {
    task: taskQuery,
    preview,
    dialogVisible,
    running,
    mode,
    run,
    close,
  }
}
