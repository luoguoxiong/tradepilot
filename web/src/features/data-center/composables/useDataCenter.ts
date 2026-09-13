import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { keepPreviousData, useQuery } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'

import { handleApiError } from '@/api/error-handler'
import {
  exportAnalyticsReport,
  getAiContribution,
  getCustomerTrend,
  getMarketDistribution,
} from '@/api/resources/analytics'
import { getEmployees } from '@/api/resources/employees'
import type { AnalyticsFilters, AnalyticsPeriod } from '@/api/types/analytics'
import type { DataScope } from '@/api/types/common'
import { usePermission } from '@/composables/usePermission'
import { qk } from '@/query/keys'
import { staleTime } from '@/query/options'

/**
 * 数据中心页面状态（15 §1.2 全局筛选 + §3.1/§3.2/§3.3 三块只读聚合）。
 * 筛选任一变化 → 三个 query key 同步变化（keepPreviousData 防图表闪烁）。
 * period=custom 未选全日期前不发请求（后端要求 startDate/endDate 成对）。
 */
export function useDataCenter() {
  const { t } = useI18n()
  const { maxScope } = usePermission()

  const period = ref<AnalyticsPeriod>('this_week')
  const customRange = ref<[string, string] | null>(null)
  const country = ref<string | undefined>(undefined)
  const employeeId = ref<string | undefined>(undefined)
  // scope 默认取角色上限：admin→all、manager→team、sales→self（05 §2）
  const scope = ref<DataScope>(maxScope.value)
  const exporting = ref(false)

  const ready = computed(
    () => period.value !== 'custom' || Boolean(customRange.value?.[0] && customRange.value?.[1]),
  )

  const filters = computed<AnalyticsFilters>(() => ({
    period: period.value,
    startDate: period.value === 'custom' ? customRange.value?.[0] : undefined,
    endDate: period.value === 'custom' ? customRange.value?.[1] : undefined,
    country: country.value || undefined,
    employeeId: employeeId.value || undefined,
    scope: scope.value,
  }))

  function sharedOptions() {
    return {
      enabled: ready,
      staleTime: staleTime.DETAIL,
      placeholderData: keepPreviousData,
    }
  }

  const trendQuery = useQuery({
    queryKey: computed(() => qk.analytics.trend(filters.value)),
    queryFn: () => getCustomerTrend(filters.value),
    ...sharedOptions(),
  })

  const distributionQuery = useQuery({
    queryKey: computed(() => qk.analytics.distribution(filters.value)),
    queryFn: () => getMarketDistribution(filters.value),
    ...sharedOptions(),
  })

  const contributionQuery = useQuery({
    queryKey: computed(() => qk.analytics.contribution(filters.value)),
    queryFn: () => getAiContribution(filters.value),
    ...sharedOptions(),
  })

  /** AI 员工筛选候选（员工列表为静态字典口径） */
  const employeesQuery = useQuery({
    queryKey: qk.employees.list(),
    queryFn: getEmployees,
    staleTime: staleTime.DICT,
  })
  const employees = computed(() =>
    (employeesQuery.data.value?.items ?? []).map((item) => ({
      value: item.employeeId,
      label: item.name,
    })),
  )

  async function exportReport() {
    if (!ready.value || exporting.value) return
    exporting.value = true
    try {
      await exportAnalyticsReport(filters.value)
      ElMessage.success(t('dataCenter.exportSuccess'))
    } catch (error) {
      handleApiError(error, { fallback: t('dataCenter.exportFailed') })
    } finally {
      exporting.value = false
    }
  }

  return {
    period,
    customRange,
    country,
    employeeId,
    scope,
    exporting,
    ready,
    filters,
    trendQuery,
    distributionQuery,
    contributionQuery,
    employees,
    exportReport,
  }
}
