<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import ManagerDiscoveryList from '../components/ManagerDiscoveryList.vue'
import ManagerOverviewCards from '../components/ManagerOverviewCards.vue'
import ManagerReportPanel from '../components/ManagerReportPanel.vue'
import ManagerTeamEfficiency from '../components/ManagerTeamEfficiency.vue'
import { useManager } from '../composables/useManager'

defineOptions({ name: 'ManagerView' })

/**
 * 13 AI 外贸经理（13 §1，P1-13-01~07）：
 * 今日经营概览（四指标）→ AI 发现（机会/风险 + 判断依据 + 一键动作）→
 * AI 团队效率（与 02 员工卡片同源）→ 经营报告（手动生成 + 五段报告详情）。
 * 权限：仅经理/管理员（路由 meta.roles + 后端 @Roles 双重校验，13 §4）。
 */
const { t } = useI18n()

const {
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
} = useManager()

const overviewLoading = computed(() => overviewQuery.isLoading.value)
const discoveriesLoading = computed(() => discoveriesQuery.isLoading.value)
const efficiencyLoading = computed(() => efficiencyQuery.isLoading.value)
const reportsLoading = computed(() => reportsQuery.isLoading.value)
const reportDetailLoading = computed(() => reportDetailQuery.isLoading.value)
</script>

<template>
  <div class="manager">
    <div class="manager__header">
      <h3 class="manager__title">{{ t('manager.title') }}</h3>
      <span class="manager__subtitle">{{ t('manager.subtitle') }}</span>
    </div>

    <section class="manager__section">
      <h4 class="manager__section-title">{{ t('manager.overviewTitle') }}</h4>
      <ManagerOverviewCards :overview="overview" :loading="overviewLoading" />
    </section>

    <section class="manager__section">
      <ManagerDiscoveryList
        :items="discoveries"
        :type="discoveryType"
        :loading="discoveriesLoading"
        :executing-id="executingId"
        @update:type="discoveryType = $event"
        @execute="runSuggestion"
      />
    </section>

    <section class="manager__section">
      <ManagerTeamEfficiency :items="efficiency" :loading="efficiencyLoading" />
    </section>

    <section class="manager__section">
      <ManagerReportPanel
        :reports="reports"
        :total="reportsTotal"
        :loading="reportsLoading"
        :period="reportPeriod"
        :filter="reportFilter"
        :page="reportPage"
        :generating="generating"
        :opened-id="openedReportId"
        :detail="reportDetail"
        :detail-loading="reportDetailLoading"
        @update:period="reportPeriod = $event"
        @update:filter="reportFilter = $event"
        @update:page="reportPage = $event"
        @generate="generateReport"
        @open="openReport"
        @close="closeReport"
      />
    </section>
  </div>
</template>

<style scoped lang="scss">
.manager {
  display: flex;
  flex-direction: column;
  gap: 16px;

  &__header {
    display: flex;
    align-items: baseline;
    gap: 12px;
  }

  &__title {
    margin: 0;
    font-size: 18px;
    font-weight: 700;
    color: var(--tp-text-primary);
  }

  &__subtitle {
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  &__section-title {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--tp-text-primary);
  }
}
</style>
