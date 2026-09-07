<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'

import AiStatusTag from '@/components/business/AiStatusTag.vue'
import DashboardSkeleton from '@/components/business/skeletons/DashboardSkeleton.vue'
import { getDashboardSummary } from '@/api/resources/dashboard'
import type { DashboardKpi, DashboardPendingItem } from '@/api/types/dashboard'
import { qk } from '@/query/keys'
import { staleTime } from '@/query/options'
import { useDictStore } from '@/stores/dict'
import { useAuthStore } from '@/stores/auth'

defineOptions({ name: 'DashboardView' })

/**
 * 01 Dashboard 工作台（只读聚合，04 §3.1）：
 * - 单聚合接口一次拉取；区块级 v-if 按返回字段存在性渲染（D1/D2，不读 0 值）；
 * - KPI 卡自适应 grid（P0 仅 2 张，P1 恢复 4 张）；
 * - 今日待处理点击按 link 携带预置筛选跳转；
 * - D3：dailyReport 字段不返回 → AI 每日报告入口不渲染。
 */
const { t } = useI18n()
const router = useRouter()
const dict = useDictStore()
const auth = useAuthStore()

const summaryQuery = useQuery({
  queryKey: qk.dashboardSummary,
  queryFn: getDashboardSummary,
  staleTime: staleTime.APPROVAL,
  refetchInterval: 15_000,
})

const summary = computed(() => summaryQuery.data.value)

// ===== 问候语（FR-01，前端按时间生成）=====
const greetingText = computed(() => {
  const hour = new Date().getHours()
  if (hour < 6) return t('dashboard.greetingNight')
  if (hour < 12) return t('dashboard.greetingMorning')
  if (hour < 18) return t('dashboard.greetingAfternoon')
  return t('dashboard.greetingEvening')
})

const dateText = computed(() =>
  new Date().toLocaleDateString(
    auth.org?.defaultLanguage === 'en' ? 'en-US' : 'zh-CN',
    { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' },
  ),
)

// ===== KPI（FR-02，D1 自适应：卡片数决定列数）=====
const kpis = computed<DashboardKpi[]>(() => summary.value?.kpis ?? [])
const kpiGridClass = computed(() =>
  kpis.value.length <= 2 ? 'dashboard__kpis is-two' : 'dashboard__kpis',
)

function trendIcon(kpi: DashboardKpi): string {
  if (kpi.trend === 'up') return '↑'
  if (kpi.trend === 'down') return '↓'
  return '—'
}

function trendClass(kpi: DashboardKpi): string {
  return { up: 'is-up', down: 'is-down', flat: 'is-flat' }[kpi.trend]
}

// ===== 今日待处理（FR-05，D2 按存在性渲染）=====
const pendingItems = computed<DashboardPendingItem[]>(() => summary.value?.pendingItems ?? [])

function onPendingClick(item: DashboardPendingItem) {
  void router.push(item.link)
}
</script>

<template>
  <!-- 首查统一骨架（06 §4）；缓存命中直接渲染 -->
  <DashboardSkeleton v-if="summaryQuery.isLoading.value" />
  <div v-else class="dashboard">
    <!-- 顶部问候区（FR-01） -->
    <div v-if="summary" class="dashboard__greeting">
      <div>
        <h3 class="dashboard__hello">
          {{ greetingText }}{{ auth.user?.name ? '，' + auth.user.name : '' }}
        </h3>
        <span class="dashboard__date">{{ dateText }}</span>
      </div>
      <span class="dashboard__online">
        {{ t('dashboard.onlineEmployees', { online: summary.greeting.onlineEmployeeCount, total: summary.greeting.onlineEmployeeTotal }) }}
      </span>
    </div>

    <!-- KPI 卡片组（FR-02，D1：仅渲染接口返回的 metric） -->
    <div :class="kpiGridClass">
      <el-card v-for="kpi in kpis" :key="kpi.metric" shadow="never" class="dashboard__kpi">
        <span class="dashboard__kpi-label">{{ t(`dashboard.metric.${kpi.metric}`) }}</span>
        <div class="dashboard__kpi-value">
          <strong>{{ kpi.value }}</strong>
          <span :class="['dashboard__kpi-trend', trendClass(kpi)]">
            {{ trendIcon(kpi) }} {{ Math.abs(kpi.changePct) }}%
          </span>
        </div>
        <span class="dashboard__kpi-compare">{{ t(`dashboard.compare.${kpi.comparePeriod}`) }}</span>
      </el-card>
    </div>

    <!-- 主体两栏：员工状态 + 右列（待处理/客户榜） -->
    <div class="dashboard__body">
      <el-card shadow="never" class="dashboard__panel">
        <template #header>{{ t('dashboard.employeeSection') }}</template>
        <div class="dashboard__employees">
          <div
            v-for="employee in summary?.aiEmployees ?? []"
            :key="employee.employeeId"
            class="dashboard__employee"
          >
            <div class="dashboard__employee-head">
              <span class="dashboard__employee-name">{{ employee.name }}</span>
              <AiStatusTag group="employeeStatus" :value="employee.status" />
            </div>
            <p class="dashboard__employee-action">{{ employee.currentAction }}</p>
            <div class="dashboard__employee-foot">
              <span>
                {{ employee.todayOutput.label }}
                <strong>{{ employee.todayOutput.count }}</strong>
                {{ employee.todayOutput.unit }}
              </span>
              <el-tag
                v-if="employee.waitingApprovalCount"
                type="warning"
                size="small"
                effect="light"
              >
                {{ t('dashboard.waitingApprovalCount', { count: employee.waitingApprovalCount }) }}
              </el-tag>
            </div>
          </div>
        </div>
      </el-card>

      <div class="dashboard__side">
        <el-card shadow="never" class="dashboard__panel">
          <template #header>{{ t('dashboard.pendingSection') }}</template>
          <div
            v-for="item in pendingItems"
            :key="item.type"
            class="dashboard__pending"
            :class="`is-${item.level}`"
            role="button"
            @click="onPendingClick(item)"
          >
            <span class="dashboard__pending-dot" />
            <span class="dashboard__pending-label">
              {{ t(`dashboard.pending.${item.type}`) }}
            </span>
            <strong class="dashboard__pending-count">{{ item.count }}</strong>
          </div>
          <el-empty
            v-if="pendingItems.length === 0"
            :description="t('common.empty')"
            :image-size="64"
          />
        </el-card>

        <el-card shadow="never" class="dashboard__panel">
          <template #header>{{ t('dashboard.highValueSection') }}</template>
          <div class="dashboard__high-value">
            <div
              v-for="customer in summary?.highValueCustomers ?? []"
              :key="customer.customerId"
              class="dashboard__high-value-row"
              role="button"
              @click="router.push(`/customers/${customer.customerId}`)"
            >
              <span class="dashboard__high-value-name">
                {{ customer.companyName }}
                <span v-if="customer.country" class="dashboard__high-value-country">
                  {{ dict.label('country', customer.country) }}
                </span>
              </span>
              <el-progress
                :percentage="customer.score"
                :stroke-width="6"
                :show-text="false"
                class="dashboard__high-value-bar"
              />
              <strong class="dashboard__high-value-score">{{ customer.score }}%</strong>
            </div>
          </div>
        </el-card>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.dashboard {
  &__greeting {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 12px;
  }

  &__hello {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__date {
    font-size: 13px;
    color: var(--tp-text-tertiary);
  }

  &__online {
    font-size: 13px;
    color: var(--ai-working);
    font-weight: 500;
  }

  &__kpis {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    margin: 16px 0;

    &.is-two {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  &__kpi {
    .el-card__body {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
  }

  &__kpi-label {
    font-size: 13px;
    color: var(--tp-text-tertiary);
  }

  &__kpi-value {
    display: flex;
    align-items: baseline;
    gap: 8px;

    strong {
      font-size: 26px;
      font-weight: 600;
      color: var(--tp-text-primary);
    }
  }

  &__kpi-trend {
    font-size: 13px;
    font-weight: 500;

    &.is-up {
      color: var(--ai-working);
    }
    &.is-down {
      color: var(--ai-risk);
    }
    &.is-flat {
      color: var(--ai-idle);
    }
  }

  &__kpi-compare {
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__body {
    display: grid;
    grid-template-columns: 3fr 2fr;
    gap: 12px;
    align-items: start;
  }

  &__side {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  &__employees {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
  }

  &__employee {
    padding: 12px;
    border: 1px solid var(--tp-border-light, #e4e7ed);
    border-radius: 8px;
  }

  &__employee-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  &__employee-name {
    font-weight: 500;
    color: var(--tp-text-primary);
  }

  &__employee-action {
    margin: 8px 0;
    font-size: 13px;
    color: var(--tp-text-secondary);
  }

  &__employee-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 13px;
    color: var(--tp-text-tertiary);

    strong {
      color: var(--tp-text-primary);
    }
  }

  &__pending {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    margin-bottom: 8px;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.2s;

    &:hover {
      background: var(--el-fill-color-light);
    }

    &:last-child {
      margin-bottom: 0;
    }

    &.is-danger .dashboard__pending-dot {
      background: var(--ai-risk);
    }
    &.is-warning .dashboard__pending-dot {
      background: var(--ai-waiting);
    }
    &.is-info .dashboard__pending-dot {
      background: var(--ai-scheduled);
    }
  }

  &__pending-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  &__pending-label {
    flex: 1;
    color: var(--tp-text-primary);
  }

  &__pending-count {
    color: var(--tp-text-primary);
  }

  &__high-value-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 0;
    cursor: pointer;

    &:hover {
      .dashboard__high-value-name {
        color: var(--el-color-primary);
      }
    }

    & + & {
      border-top: 1px solid var(--tp-border-light, #f0f0f0);
    }
  }

  &__high-value-name {
    flex: 1;
    font-size: 13px;
    color: var(--tp-text-primary);
  }

  &__high-value-country {
    margin-left: 4px;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__high-value-bar {
    width: 120px;
  }

  &__high-value-score {
    width: 40px;
    text-align: right;
    font-size: 13px;
    color: var(--tp-text-primary);
  }
}
</style>
