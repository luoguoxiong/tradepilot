<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useQuery, useQueryClient } from '@tanstack/vue-query'

import ProTable from '@/components/business/ProTable.vue'
import type { ProColumn } from '@/components/business/pro-table'
import { getFollowUpSummary, getFollowUpTasks, pauseFollowUpTask, skipFollowUpTask } from '@/api/resources/follow-ups'
import type { FollowUpTaskItem, FollowUpTaskQuery } from '@/api/types/follow-up'
import { qk } from '@/query/keys'
import { staleTime } from '@/query/options'
import { useAuthStore } from '@/stores/auth'
import { DEFAULT_TIMEZONE, inOrgTz } from '@/utils/date'

defineOptions({ name: 'FollowUpTasksView' })

/**
 * 07 跟进任务总览（FR-01/FR-02，04 §3.5）：
 * - 正在执行 N 个任务 + 状态 Tab（all/today/waiting_approval/completed，各档数量）；
 * - next_run_at 按企业时区展示（Today/Tomorrow/日期；「今天待执行」= 企业当地日历日）；
 * - 行内操作：暂停（客户回复场景）/ 跳过下一步；waiting_approval 处置走 12 审核中心。
 */
const { t } = useI18n()
const router = useRouter()
const queryClient = useQueryClient()
const auth = useAuthStore()

const columns: ProColumn[] = [
  { prop: 'companyName', labelKey: 'followUp.company', minWidth: 160 },
  { prop: 'currentStage', labelKey: 'followUp.currentStage', minWidth: 120, enumGroup: 'followUpStage' },
  { prop: 'nextRunAt', labelKey: 'followUp.nextRunAt', minWidth: 140 },
  { prop: 'status', labelKey: 'followUp.status', width: 120, enumGroup: 'followUpTaskStatus' },
  { prop: 'strategyName', labelKey: 'followUp.strategyName', minWidth: 150 },
  { prop: 'actions', labelKey: 'followUp.actions', width: 150, fixed: 'right' },
]

const activeTab = ref<'all' | 'today' | 'waiting_approval' | 'completed'>('all')

const summaryQuery = useQuery({
  queryKey: qk.followUps.summary(),
  queryFn: getFollowUpSummary,
  staleTime: staleTime.APPROVAL,
  refetchInterval: 15_000,
})

const summary = computed(() => summaryQuery.data.value)

const tabs = computed(() => [
  { key: 'all' as const, label: t('followUp.tabAll'), count: summary.value?.tabs.all ?? 0 },
  { key: 'today' as const, label: t('followUp.tabToday'), count: summary.value?.tabs.today ?? 0 },
  {
    key: 'waiting_approval' as const,
    label: t('followUp.tabWaiting'),
    count: summary.value?.tabs.waitingApproval ?? 0,
  },
  {
    key: 'completed' as const,
    label: t('followUp.tabCompleted'),
    count: summary.value?.tabs.completed ?? 0,
  },
])

const fetchTasks = (params: Record<string, unknown>) => getFollowUpTasks(params as FollowUpTaskQuery)

/** 企业时区（next_run_at 存 UTC，展示/触发按企业时区换算，07 §4） */
const timezone = computed(() => auth.org?.timezone ?? DEFAULT_TIMEZONE)

function nextRunLabel(iso: string): string {
  const target = inOrgTz(iso, timezone.value)
  if (!target) return '—'
  const now = inOrgTz(new Date().toISOString(), timezone.value)
  if (!now) return '—'
  const sameDay = target.isSame(now, 'day')
  const tomorrow = target.isSame(now.add(1, 'day'), 'day')
  if (sameDay) return t('followUp.today')
  if (tomorrow) return t('followUp.tomorrow')
  return target.format('MM-DD')
}

async function onPause(task: FollowUpTaskItem) {
  try {
    await pauseFollowUpTask(task.followUpTaskId)
    ElMessage.success(t('followUp.paused'))
    void queryClient.invalidateQueries({ queryKey: qk.followUps.all })
  } catch (error) {
    ElMessage.error((error as Error).message || t('common.operationFailed'))
  }
}

async function onSkip(task: FollowUpTaskItem) {
  try {
    await skipFollowUpTask(task.followUpTaskId)
    ElMessage.success(t('followUp.skipped'))
    void queryClient.invalidateQueries({ queryKey: qk.followUps.all })
  } catch (error) {
    ElMessage.error((error as Error).message || t('common.operationFailed'))
  }
}

function canPause(task: FollowUpTaskItem): boolean {
  return task.status !== 'completed' && task.status !== 'paused'
}

function canSkip(task: FollowUpTaskItem): boolean {
  return task.status === 'ready' || task.status === 'scheduled'
}

function goCustomer(task: FollowUpTaskItem) {
  void router.push(`/customers/${task.customerId}`)
}
</script>

<template>
  <div class="follow-up-tasks">
    <div class="follow-up-tasks__header">
      <h3 class="follow-up-tasks__title">{{ t('followUp.tasksTitle') }}</h3>
      <span class="follow-up-tasks__executing">
        {{ t('followUp.executingCount', { count: summary?.executingCount ?? 0 }) }}
      </span>
    </div>

    <el-tabs v-model="activeTab" class="follow-up-tasks__tabs">
      <el-tab-pane v-for="tab in tabs" :key="tab.key" :name="tab.key">
        <template #label>
          {{ tab.label }}
          <el-badge :value="tab.count" type="info" class="follow-up-tasks__badge" />
        </template>
      </el-tab-pane>
    </el-tabs>

    <ProTable
      :columns="columns"
      :fetcher="fetchTasks"
      :query-key-base="qk.followUps.all"
      :external-query="{ tab: activeTab }"
      :searchable="true"
      row-key="followUpTaskId"
    >
      <template #col-companyName="{ row }">
        <el-link type="primary" @click="goCustomer(row)">
          {{ row.companyName }}
        </el-link>
      </template>
      <template #col-nextRunAt="{ row }">
        {{ nextRunLabel(row.nextRunAt) }}
      </template>
      <template #col-actions="{ row }">
        <el-button v-if="canPause(row)" link size="small" @click="onPause(row)">
          {{ t('followUp.pause') }}
        </el-button>
        <el-button v-if="canSkip(row)" link size="small" @click="onSkip(row)">
          {{ t('followUp.skip') }}
        </el-button>
        <span v-if="!canPause(row) && !canSkip(row)" class="follow-up-tasks__no-action">—</span>
      </template>
    </ProTable>
  </div>
</template>

<style scoped lang="scss">
.follow-up-tasks {
  &__header {
    display: flex;
    align-items: baseline;
    gap: 12px;
  }

  &__title {
    margin: 0;
    font-size: 18px;
    color: var(--tp-text-primary);
  }

  &__executing {
    font-size: 13px;
    color: var(--tp-text-secondary);
  }

  &__tabs {
    margin-bottom: 4px;

    :deep(.el-tabs__header) {
      margin-bottom: 8px;
    }
  }

  &__badge {
    margin-left: 4px;
    vertical-align: middle;

    :deep(.el-badge__content) {
      position: static;
      transform: none;
    }
  }

  &__no-action {
    color: var(--tp-text-tertiary);
  }
}
</style>
