import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'

import { handleApiError } from '@/api/error-handler'
import { ErrorCode } from '@/api/error-codes'
import { ApiError } from '@/api/http'
import { generateDashboardDailyReport, getDashboardDailyReport } from '@/api/resources/dashboard'
import type { DashboardDailyReport } from '@/api/types/dashboard'
import { qk } from '@/query/keys'
import { staleTime } from '@/query/options'

/**
 * D3 AI 每日报告（01 §3.2/§3.3，随 13 恢复）：
 * - 打开弹层才请求（`enabled`）；无日报（40401）→ `null`，渲染「暂无报告 + 可生成」空态；
 * - `status='generating'` 时按 3s 轮询，`ready`/`failed` 停止；
 * - 生成走 13 经营报告异步任务（`business_analysis`），成功即失效当前 key 由轮询接管进度。
 */
export function useDailyReport() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const visible = ref(false)
  const generating = ref(false)

  const reportQuery = useQuery({
    queryKey: qk.dashboardDailyReport,
    queryFn: async (): Promise<DashboardDailyReport | null> => {
      try {
        return await getDashboardDailyReport()
      } catch (error) {
        // 40401 = 尚无日报（01 §3.2 无报告语义），按空态渲染而非错误态
        if (error instanceof ApiError && error.code === ErrorCode.NOT_FOUND) return null
        throw error
      }
    },
    enabled: computed(() => visible.value),
    staleTime: staleTime.DETAIL,
    refetchInterval: (query) =>
      query.state.data?.status === 'generating' ? staleTime.TASK_RUNNING : false,
  })

  const report = computed(() => reportQuery.data.value ?? null)

  function open() {
    visible.value = true
  }

  function close() {
    visible.value = false
  }

  /** 触发生成：服务端落 business_report(generating) 并投递任务，前端轮询等 ready */
  async function generate() {
    if (generating.value) return
    generating.value = true
    try {
      await generateDashboardDailyReport({ period: 'daily' })
      ElMessage.success(t('dashboard.reportGenerating'))
      await queryClient.invalidateQueries({ queryKey: qk.dashboardDailyReport })
    } catch (error) {
      handleApiError(error, { fallback: t('dashboard.reportGenerateFailed') })
    } finally {
      generating.value = false
    }
  }

  return { visible, generating, report, reportQuery, open, close, generate }
}
