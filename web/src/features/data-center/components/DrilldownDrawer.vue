<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { keepPreviousData, useQuery } from '@tanstack/vue-query'

import EmptyState from '@/components/business/EmptyState.vue'
import { getDrilldown } from '@/api/resources/analytics'
import type { AnalyticsFilters, AnalyticsMetric, DrilldownItem } from '@/api/types/analytics'
import { qk } from '@/query/keys'
import { staleTime } from '@/query/options'
import { useDictStore } from '@/stores/dict'
import { ITEM_ROUTE, ITEM_TYPE_LABEL_KEY, METRIC_LABEL_KEY } from '../constants'

/**
 * 指标下钻明细抽屉（15 §3.4 / §4 可下钻验证）。
 * 明细口径与卡片/图例同源（后端同 SQL 聚合），total 即卡片数值。
 */
const props = defineProps<{
  visible: boolean
  metric: AnalyticsMetric
  filters: AnalyticsFilters
}>()

const emit = defineEmits<{ 'update:visible': [value: boolean] }>()

const PAGE_SIZE = 20

const { t } = useI18n()
const router = useRouter()
const dict = useDictStore()

const page = ref(1)

// 切换指标 / 筛选 / 重新打开均回到第一页
watch(
  () => [props.metric, props.filters, props.visible] as const,
  () => {
    page.value = 1
  },
)

const query = useQuery({
  queryKey: computed(() => qk.analytics.drilldown(props.metric, props.filters, page.value)),
  queryFn: () =>
    getDrilldown({
      ...props.filters,
      metric: props.metric,
      page: page.value,
      pageSize: PAGE_SIZE,
    }),
  enabled: computed(() => props.visible),
  staleTime: staleTime.DETAIL,
  placeholderData: keepPreviousData,
})

const items = computed(() => query.data.value?.items ?? [])
const total = computed(() => query.data.value?.total ?? 0)

function formatDateTime(value: string): string {
  return value ? new Date(value).toLocaleString() : '—'
}

function typeLabel(type: string): string {
  const key = ITEM_TYPE_LABEL_KEY[type]
  return key ? t(key) : type
}

function amountText(row: DrilldownItem): string {
  if (row.amount === null || row.amount === undefined || row.amount === '') return '—'
  if (props.metric === 'saved_hours') return `${row.amount} ${t('dataCenter.minutesUnit')}`
  return row.currency ? `${row.amount} ${row.currency}` : row.amount
}

function onRowClick(row: DrilldownItem) {
  const resolve = ITEM_ROUTE[row.type]
  if (!resolve) return
  emit('update:visible', false)
  void router.push(resolve(row.id))
}
</script>

<template>
  <el-drawer
    :model-value="props.visible"
    :title="t('dataCenter.drilldownTitle', { metric: t(METRIC_LABEL_KEY[props.metric]) })"
    size="760px"
    append-to-body
    destroy-on-close
    @update:model-value="emit('update:visible', $event)"
  >
    <div v-loading="query.isFetching.value" class="drilldown">
      <p class="drilldown__summary">
        {{ t('dataCenter.drilldownTotal', { metric: t(METRIC_LABEL_KEY[props.metric]), total }) }}
      </p>

      <EmptyState v-if="!query.isLoading.value && items.length === 0" />
      <el-table v-else :data="items" row-key="id" stripe @row-click="onRowClick">
        <el-table-column :label="t('dataCenter.colTitle')" min-width="220">
          <template #default="{ row }">
            <span class="drilldown__title">{{ row.title }}</span>
            <span class="drilldown__type">{{ typeLabel(row.type) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="subtitle" :label="t('dataCenter.colSubtitle')" min-width="140">
          <template #default="{ row }">{{ row.subtitle ?? '—' }}</template>
        </el-table-column>
        <el-table-column :label="t('dataCenter.colCountry')" width="110">
          <template #default="{ row }">
            {{ row.country ? dict.label('country', row.country) : '—' }}
          </template>
        </el-table-column>
        <el-table-column :label="t('dataCenter.colOwner')" width="120">
          <template #default="{ row }">{{ row.ownerName ?? '—' }}</template>
        </el-table-column>
        <el-table-column :label="t('dataCenter.colAmount')" width="130">
          <template #default="{ row }">{{ amountText(row) }}</template>
        </el-table-column>
        <el-table-column :label="t('dataCenter.colOccurredAt')" width="170">
          <template #default="{ row }">{{ formatDateTime(row.occurredAt) }}</template>
        </el-table-column>
      </el-table>

      <div v-if="total > PAGE_SIZE" class="drilldown__pager">
        <el-pagination
          v-model:current-page="page"
          :page-size="PAGE_SIZE"
          :total="total"
          layout="total, prev, pager, next"
          background
        />
      </div>
    </div>
  </el-drawer>
</template>

<style scoped lang="scss">
.drilldown {
  &__summary {
    margin: 0 0 12px;
    font-size: 13px;
    color: var(--tp-text-secondary);
  }

  &__title {
    margin-right: 8px;
    color: var(--tp-text-primary);
  }

  &__type {
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__pager {
    display: flex;
    justify-content: flex-end;
    margin-top: 12px;
  }

  :deep(.el-table__row) {
    cursor: pointer;
  }
}
</style>
