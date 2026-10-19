import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'

import { handleApiError } from '@/api/error-handler'
import {
  executeDiscovery,
  generateManagerReport,
  getManagerDiscoveries,
  getManagerOverview,
  getManagerReport,
  getManagerReports,
  getTeamEfficiency,
} from '@/api/resources/manager'
import type {
  ManagerDiscovery,
  ManagerDiscoveryType,
  ManagerReportPeriod,
} from '@/api/types/manager'
import { qk } from '@/query/keys'
import { listQueryOptions, staleTime } from '@/query/options'

/**
 * AI 外贸经理页面状态（13 §1）。
 * - 概览 30s 轮询（与 15 数据中心同档：聚合口径 staleTime.DETAIL）；
 * - 发现列表读取即刷新（服务端实时重算并幂等写回）；
 * - 一键执行成功后失效整个 manager 命名空间（发现状态 + 报告列表联动）。
 */
export function useManager() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const discoveryType = ref<ManagerDiscoveryType>('all')
  const reportPeriod = ref<ManagerReportPeriod>('daily')
  const reportFilter = ref<ManagerReportPeriod | 'all'>('all')
  const reportPage = ref(1)
  const openedReportId = ref<string | null>(null)
  const executingId = ref<string | null>(null)
  const generating = ref(false)

  /** 13 §3.1 今日经营概览（date 缺省今天，由服务端按 org 时区解析） */
  const overviewQuery = useQuery({
    queryKey: qk.manager.overview('today'),
    queryFn: () => getManagerOverview(),
    staleTime: staleTime.DETAIL,
    refetchInterval: 30_000,
  })

  /** 13 §3.2 发现列表（type 进 key，切换 Tab 即重算） */
  const discoveriesQuery = useQuery({
    queryKey: computed(() => qk.manager.discoveries(discoveryType.value)),
    queryFn: () => getManagerDiscoveries({ type: discoveryType.value }),
    staleTime: staleTime.DETAIL,
  })

  /** 13 §1.3 团队效率 */
  const efficiencyQuery = useQuery({
    queryKey: qk.manager.efficiency(),
    queryFn: getTeamEfficiency,
    staleTime: staleTime.DETAIL,
  })

  /** 13 §1.4 报告列表（period + 分页进 key） */
  const reportsQuery = useQuery({
    queryKey: computed(() =>
      qk.manager.reports({ period: reportFilter.value, page: reportPage.value }),
    ),
    queryFn: () => getManagerReports({ period: reportFilter.value, page: reportPage.value }),
    // 周期切换 / 翻页保留上一页数据，避免表格抖动（03 §5.2）
    ...listQueryOptions(),
  })

  /** 13 §1.4 报告详情（抽屉打开时才请求；生成中 3s 轮询直到 ready/failed） */
  const reportDetailQuery = useQuery({
    queryKey: computed(() => qk.manager.report(openedReportId.value ?? 'none')),
    queryFn: () => getManagerReport(openedReportId.value as string),
    enabled: computed(() => openedReportId.value !== null),
    staleTime: staleTime.DETAIL,
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status === 'generating' ? staleTime.TASK_RUNNING : false
    },
  })

  const overview = computed(() => overviewQuery.data.value ?? null)
  const discoveries = computed<ManagerDiscovery[]>(() => discoveriesQuery.data.value?.items ?? [])
  const efficiency = computed(() => efficiencyQuery.data.value?.items ?? [])
  const reports = computed(() => reportsQuery.data.value?.items ?? [])
  const reportsTotal = computed(() => reportsQuery.data.value?.total ?? 0)
  const reportDetail = computed(() => reportDetailQuery.data.value ?? null)

  /** 13 §3.3 一键执行（成功后折叠为「已执行」，同时刷新任务/策略相关缓存） */
  async function runSuggestion(discovery: ManagerDiscovery) {
    if (executingId.value) return
    executingId.value = discovery.discoveryId
    try {
      const result = await executeDiscovery(discovery.discoveryId)
      ElMessage.success(
        result.taskId ? t('manager.discovery.taskStarted') : t('manager.discovery.strategyEnabled'),
      )
      await queryClient.invalidateQueries({ queryKey: qk.manager.all })
      if (result.taskId) {
        await queryClient.invalidateQueries({ queryKey: qk.tasks.all })
      }
      if (result.strategyId) {
        await queryClient.invalidateQueries({ queryKey: qk.followUps.all })
      }
    } catch (error) {
      handleApiError(error, { fallback: t('manager.discovery.executeFailed') })
    } finally {
      executingId.value = null
    }
  }

  /** 13 §3.4 生成报告（异步）：成功即打开抽屉跟踪进度 */
  async function generateReport() {
    if (generating.value) return
    generating.value = true
    try {
      const result = await generateManagerReport({ period: reportPeriod.value })
      ElMessage.success(t('manager.report.generated'))
      reportFilter.value = reportPeriod.value
      reportPage.value = 1
      openedReportId.value = result.reportId
      await queryClient.invalidateQueries({ queryKey: qk.manager.all })
    } catch (error) {
      handleApiError(error, { fallback: t('manager.report.generateFailed') })
    } finally {
      generating.value = false
    }
  }

  function openReport(reportId: string) {
    openedReportId.value = reportId
  }

  function closeReport() {
    openedReportId.value = null
  }

  return {
    discoveryType,
    reportPeriod,
    reportFilter,
    reportPage,
    openedReportId,
    executingId,
    generating,
    overview,
    discoveries,
    efficiency,
    reports,
    reportsTotal,
    reportDetail,
    overviewQuery,
    discoveriesQuery,
    efficiencyQuery,
    reportsQuery,
    reportDetailQuery,
    runSuggestion,
    generateReport,
    openReport,
    closeReport,
  }
}
