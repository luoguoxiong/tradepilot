<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'

import AiStatusTag from '@/components/business/AiStatusTag.vue'
import EmptyState from '@/components/business/EmptyState.vue'
import DashboardSkeleton from '@/components/business/skeletons/DashboardSkeleton.vue'
import ReportMarkdown from '@/features/manager/components/ReportMarkdown.vue'
import { getDashboardSummary } from '@/api/resources/dashboard'
import type { DashboardKpi, DashboardPendingItem } from '@/api/types/dashboard'
import { useDailyReport } from '@/features/dashboard/composables/useDailyReport'
import { features } from '@/features'
import { qk } from '@/query/keys'
import { staleTime } from '@/query/options'
import { usePermission } from '@/composables/usePermission'
import { useDictStore } from '@/stores/dict'
import { useAuthStore } from '@/stores/auth'
import { formatInOrgTz } from '@/utils/date'

defineOptions({ name: 'DashboardView' })

/**
 * 01 Dashboard 工作台（只读聚合，04 §3.1）：
 * - 单聚合接口一次拉取；区块级 v-if 按返回字段存在性渲染（D1/D2）；
 * - KPI 卡自适应 grid：D1 恢复 4 张（new_quotes/estimated_revenue 由后端随 09/10 返回），
 *   金额类 KPI 展示币种 +「预计」角标（01 §4：estimated_revenue 为估算值，前端标注）；
 * - 今日待处理点击按 link 携带预置筛选跳转；
 * - D3：AI 每日报告入口随 13（`features.manager`，经理视角故同时要求 admin/manager），
 *   点击打开报告弹层（无日报 → 空态 + 生成，生成中 3s 轮询）；
 * - D14：04 §5.1 FR-06「进入待办中心」入口随 14 任务中心启用（`features.taskCenter`），
 *   P1 无独立待办中心页面，由 14 任务中心承载统一待办处理（待审/失败/运行中），P0 不渲染。
 */
const { t } = useI18n()
const router = useRouter()
const dict = useDictStore()
const auth = useAuthStore()
const { canManage } = usePermission()

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
  new Date().toLocaleDateString(auth.org?.defaultLanguage === 'en' ? 'en-US' : 'zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }),
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

/** 金额类 KPI（estimated_revenue）：千分位 + 2 位小数（后端返回原始数值字符串） */
function kpiValue(kpi: DashboardKpi): string {
  if (typeof kpi.value === 'number') return String(kpi.value)
  const amount = Number(kpi.value)
  return Number.isFinite(amount)
    ? amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : kpi.value
}

/** 仅金额类 KPI 展示币种（计数类不携带 currency） */
function kpiCurrency(kpi: DashboardKpi): string {
  return kpi.metric === 'estimated_revenue' ? (kpi.currency ?? 'USD') : ''
}

// ===== AI 每日报告（FR-01，D3：随 13 恢复；经营报告为经理视角）=====
const canViewDailyReport = computed(() => features.manager && canManage.value)
const daily = useDailyReport()
const report = computed(() => daily.report.value)
const reportStatusTag: Record<string, 'success' | 'warning' | 'danger'> = {
  ready: 'success',
  generating: 'warning',
  failed: 'danger',
}
const reportGeneratedAt = computed(() =>
  formatInOrgTz(report.value?.generatedAt, auth.org?.timezone, 'YYYY-MM-DD HH:mm'),
)

// ===== 今日待处理（FR-05，D2 按存在性渲染）=====
const pendingItems = computed<DashboardPendingItem[]>(() => summary.value?.pendingItems ?? [])

function onPendingClick(item: DashboardPendingItem) {
  void router.push(item.link)
}

// ===== 待办中心入口（FR-06，D14：随 14 任务中心启用）=====
const canEnterTaskCenter = computed(() => features.taskCenter)

function goTaskCenter() {
  void router.push('/tasks')
}
</script>

<template>
  <!-- 首查统一骨架（06 §4）；缓存命中直接渲染 -->
  <DashboardSkeleton v-if="summaryQuery.isLoading.value" />
  <div v-else class="dashboard">
    <!-- 顶部问候区（FR-01；D3：AI 每日报告入口随 13 恢复） -->
    <div v-if="summary" class="dashboard__greeting">
      <div>
        <h3 class="dashboard__hello">
          {{ greetingText }}{{ auth.user?.name ? '，' + auth.user.name : '' }}
        </h3>
        <span class="dashboard__date">{{ dateText }}</span>
      </div>
      <div class="dashboard__greeting-actions">
        <el-button v-if="canViewDailyReport" link type="primary" @click="daily.open">
          {{ t('dashboard.dailyReport') }} →
        </el-button>
        <span class="dashboard__online">
          {{
            t('dashboard.onlineEmployees', {
              online: summary.greeting.onlineEmployeeCount,
              total: summary.greeting.onlineEmployeeTotal,
            })
          }}
        </span>
      </div>
    </div>

    <!-- KPI 卡片组（FR-02，D1：仅渲染接口返回的 metric） -->
    <div :class="kpiGridClass">
      <el-card v-for="kpi in kpis" :key="kpi.metric" shadow="never" class="dashboard__kpi">
        <span class="dashboard__kpi-label">
          {{ t(`dashboard.metric.${kpi.metric}`) }}
          <!-- 01 §4：estimated_revenue 为估算值，需标注「预计」 -->
          <el-tag
            v-if="kpi.metric === 'estimated_revenue'"
            class="dashboard__kpi-tag"
            size="small"
            effect="plain"
          >
            {{ t('dashboard.estimatedTag') }}
          </el-tag>
        </span>
        <div class="dashboard__kpi-value">
          <strong>
            <span v-if="kpiCurrency(kpi)" class="dashboard__kpi-currency">{{
              kpiCurrency(kpi)
            }}</span>
            {{ kpiValue(kpi) }}
          </strong>
          <span :class="['dashboard__kpi-trend', trendClass(kpi)]">
            {{ trendIcon(kpi) }} {{ Math.abs(kpi.changePct) }}%
          </span>
        </div>
        <span class="dashboard__kpi-compare">{{
          t(`dashboard.compare.${kpi.comparePeriod}`)
        }}</span>
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
          <!-- D14：统一待办入口（P1 由 14 任务中心承载） -->
          <div v-if="canEnterTaskCenter" class="dashboard__pending-foot">
            <el-button link type="primary" @click="goTaskCenter">
              {{ t('dashboard.enterTodoCenter') }}
            </el-button>
          </div>
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

    <!-- D3：AI 每日报告弹层（复用 13 报告只读渲染；无日报 → 空态 + 生成） -->
    <el-dialog
      v-model="daily.visible.value"
      :title="t('dashboard.dailyReport')"
      width="720px"
      destroy-on-close
    >
      <el-skeleton v-if="daily.reportQuery.isLoading.value" :rows="6" animated />
      <template v-else-if="report">
        <div class="dashboard__report-meta">
          <el-tag :type="reportStatusTag[report.status] ?? 'info'" size="small" effect="light">
            {{ t(`dashboard.reportStatus.${report.status}`) }}
          </el-tag>
          <span v-if="report.generatedAt" class="dashboard__report-time">
            {{ t('dashboard.reportGeneratedAt', { time: reportGeneratedAt }) }}
          </span>
          <el-button link type="primary" :loading="daily.generating.value" @click="daily.generate">
            {{ t('dashboard.regenerateReport') }}
          </el-button>
        </div>
        <ReportMarkdown v-if="report.content" :content="report.content" />
        <el-empty
          v-else
          :description="
            report.status === 'failed'
              ? t('dashboard.reportFailed')
              : t('dashboard.reportGenerating')
          "
          :image-size="64"
        />
      </template>
      <EmptyState
        v-else
        :title="t('dashboard.reportEmpty')"
        :description="t('dashboard.reportEmptyHint')"
      >
        <el-button type="primary" :loading="daily.generating.value" @click="daily.generate">
          {{ t('dashboard.generateReport') }}
        </el-button>
      </EmptyState>
    </el-dialog>
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

  &__greeting-actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  &__online {
    font-size: 13px;
    color: var(--ai-working);
    font-weight: 500;
  }

  &__report-meta {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }

  &__report-time {
    font-size: 12px;
    color: var(--tp-text-tertiary);
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
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--tp-text-tertiary);
  }

  &__kpi-tag {
    transform: scale(0.9);
  }

  &__kpi-currency {
    margin-right: 2px;
    font-size: 14px;
    font-weight: 500;
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

  &__pending-foot {
    display: flex;
    justify-content: flex-end;
    margin-top: 8px;
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
