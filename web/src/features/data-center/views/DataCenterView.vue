<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { Download } from '@element-plus/icons-vue'

import ScopeSelect from '@/components/business/ScopeSelect.vue'
import AiContributionCards from '../components/AiContributionCards.vue'
import DrilldownDrawer from '../components/DrilldownDrawer.vue'
import MarketDistribution from '../components/MarketDistribution.vue'
import TrendChart from '../components/TrendChart.vue'
import { useDataCenter } from '../composables/useDataCenter'
import {
  ANALYTICS_METRICS,
  type AnalyticsMetric,
  type AnalyticsPeriod,
} from '@/api/types/analytics'
import { useDictStore } from '@/stores/dict'

defineOptions({ name: 'DataCenterView' })

/**
 * 15 数据中心（15 §1/§3，P1-15-01~06）：
 * 全局筛选（周期 / 国家 / AI 员工 / 数据范围）→ AI 贡献卡 + 增长趋势 + 市场分布，
 * 卡片与图表均可下钻明细（15 §4），支持导出当前筛选报表。
 * 支持深链：`/data-center?metric=&period=&startDate=&endDate=&country=`（13 §3.2 发现证据 ref 落地）。
 */
const { t } = useI18n()
const dict = useDictStore()

const {
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
} = useDataCenter()

/** 统计周期（15 §1.2） */
const PERIODS = [
  { value: 'this_week', labelKey: 'dataCenter.period.thisWeek' },
  { value: 'this_month', labelKey: 'dataCenter.period.thisMonth' },
  { value: 'custom', labelKey: 'dataCenter.period.custom' },
] as const

const countryOptions = computed(() =>
  dict.options('country').map((option) => ({ value: option.value, label: t(option.labelKey) })),
)

const trendPoints = computed(() => trendQuery.data.value?.trend ?? [])
const markets = computed(() => distributionQuery.data.value?.markets ?? [])
const contribution = computed(() => contributionQuery.data.value)

// ===== 下钻（15 §3.4）=====
const drilldownMetric = ref<AnalyticsMetric | null>(null)

const drawerVisible = computed({
  get: () => drilldownMetric.value !== null,
  set: (value: boolean) => {
    if (!value) drilldownMetric.value = null
  },
})

function openDrilldown(metric: AnalyticsMetric) {
  drilldownMetric.value = metric
}

/** 市场分布下钻：先收敛到该国家筛选，再看该市场新客户明细（OTHER 不改变筛选） */
function onMarketDrilldown(marketCountry: string) {
  if (marketCountry !== 'OTHER') country.value = marketCountry
  drilldownMetric.value = 'new_customers'
}

// ===== 深链（13 §3.2 发现证据 ref）=====
const route = useRoute()

/** 从 query 恢复筛选并直接打开对应指标明细；非法值一律忽略，不影响页面默认行为 */
function applyDeepLink() {
  const qCountry = typeof route.query.country === 'string' ? route.query.country : ''
  if (qCountry) country.value = qCountry

  const qPeriod = route.query.period
  if (typeof qPeriod === 'string' && PERIODS.some((item) => item.value === qPeriod)) {
    period.value = qPeriod as AnalyticsPeriod
  }

  const startDate = typeof route.query.startDate === 'string' ? route.query.startDate : ''
  const endDate = typeof route.query.endDate === 'string' ? route.query.endDate : ''
  if (period.value === 'custom' && startDate && endDate) {
    customRange.value = [startDate, endDate]
  }

  const metric = typeof route.query.metric === 'string' ? route.query.metric : ''
  if ((ANALYTICS_METRICS as readonly string[]).includes(metric)) {
    drilldownMetric.value = metric as AnalyticsMetric
  }
}

applyDeepLink()
// 同页二次深链（如从经理页连续点两条证据）同样生效
watch(() => route.query, applyDeepLink)
</script>

<template>
  <div class="data-center">
    <div class="data-center__header">
      <h3 class="data-center__title">{{ t('dataCenter.title') }}</h3>
      <div class="data-center__actions">
        <ScopeSelect v-model="scope" />
        <el-button type="primary" :loading="exporting" :disabled="!ready" @click="exportReport">
          <el-icon><Download /></el-icon>{{ t('dataCenter.export') }}
        </el-button>
      </div>
    </div>

    <div class="data-center__filters">
      <el-select v-model="period" style="width: 140px">
        <el-option
          v-for="item in PERIODS"
          :key="item.value"
          :value="item.value"
          :label="t(item.labelKey)"
        />
      </el-select>
      <el-date-picker
        v-if="period === 'custom'"
        v-model="customRange"
        type="daterange"
        value-format="YYYY-MM-DD"
        :start-placeholder="t('dataCenter.startDate')"
        :end-placeholder="t('dataCenter.endDate')"
        style="width: 260px"
      />
      <el-select
        v-model="country"
        clearable
        :placeholder="t('dataCenter.countryFilter')"
        style="width: 160px"
      >
        <el-option
          v-for="option in countryOptions"
          :key="option.value"
          :value="option.value"
          :label="option.label"
        />
      </el-select>
      <el-select
        v-model="employeeId"
        clearable
        :placeholder="t('dataCenter.employeeFilter')"
        style="width: 180px"
      >
        <el-option
          v-for="option in employees"
          :key="option.value"
          :value="option.value"
          :label="option.label"
        />
      </el-select>
      <span v-if="period === 'custom' && !ready" class="data-center__hint">
        {{ t('dataCenter.customRangeRequired') }}
      </span>
    </div>

    <!-- AI 贡献（15 §3.3，含估算口径说明） -->
    <AiContributionCards
      :contribution="contribution"
      :loading="contributionQuery.isLoading.value"
      @drilldown="openDrilldown"
    />

    <div class="data-center__grid">
      <el-card shadow="never">
        <template #header>{{ t('dataCenter.trendSection') }}</template>
        <TrendChart
          :points="trendPoints"
          :loading="trendQuery.isLoading.value"
          @drilldown="openDrilldown"
        />
      </el-card>

      <el-card shadow="never">
        <template #header>{{ t('dataCenter.marketSection') }}</template>
        <MarketDistribution
          :markets="markets"
          :loading="distributionQuery.isLoading.value"
          @drilldown="onMarketDrilldown"
        />
      </el-card>
    </div>

    <DrilldownDrawer
      :visible="drawerVisible"
      :metric="drilldownMetric ?? 'new_customers'"
      :filters="filters"
      @update:visible="drawerVisible = $event"
    />
  </div>
</template>

<style scoped lang="scss">
.data-center {
  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: calc(var(--tp-spacing-base) * 2);
  }

  &__title {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  &__filters {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: calc(var(--tp-spacing-base) * 2);
  }

  &__hint {
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__grid {
    display: grid;
    grid-template-columns: 2fr 1fr;
    gap: 12px;
    margin-top: 12px;
    align-items: start;
  }
}
</style>
