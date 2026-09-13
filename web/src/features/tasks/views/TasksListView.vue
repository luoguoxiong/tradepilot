<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useQueryClient } from '@tanstack/vue-query'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'

import ProTable from '@/components/business/ProTable.vue'
import NewTaskDialog from '../components/NewTaskDialog.vue'
import TransferToHumanDialog from '../components/TransferToHumanDialog.vue'
import { fetchTasks } from '../composables/useTasks'
import { batchTaskAction } from '@/api/resources/tasks'
import { handleApiError } from '@/api/error-handler'
import { qk } from '@/query/keys'
import type { BatchTaskActionReq, TaskItem, TaskTab } from '@/api/types/tasks'
import type { ProColumn } from '@/components/business/pro-table'
import type { FilterField } from '@/components/business/FilterBar.vue'

defineOptions({ name: 'TasksListView' })

/**
 * 14 AI 任务中心列表（14 §1.1/§2，FR-01/FR-02/FR-04）：
 * 状态 Tab 筛选（all/running/waiting_approval/completed/failed）→ externalQuery 进全量 query key；
 * `+ 新任务` 统一入口；「失败」页签开放多选批量处理（重试 / 转人工，14 §3.7）。
 */
const { t } = useI18n()
const router = useRouter()
const queryClient = useQueryClient()

const columns: ProColumn[] = [
  { prop: 'title', labelKey: 'tasks.task', minWidth: 240 },
  { prop: 'employeeName', labelKey: 'tasks.employee', width: 160 },
  { prop: 'type', labelKey: 'tasks.type', width: 130, enumGroup: 'taskType' },
  { prop: 'status', labelKey: 'tasks.status', width: 120, enumGroup: 'taskStatus' },
  { prop: 'progressPct', labelKey: 'tasks.progress', width: 180 },
  { prop: 'createdAt', labelKey: 'tasks.createdAt', width: 180 },
]

/** 状态 Tab（14 FR-01；『全部』不传 status，其余为单状态精确筛选） */
const tabs: { value: TaskTab; labelKey: string }[] = [
  { value: 'all', labelKey: 'tasks.tabAll' },
  { value: 'running', labelKey: 'tasks.tabRunning' },
  { value: 'waiting_approval', labelKey: 'tasks.tabWaitingApproval' },
  { value: 'completed', labelKey: 'tasks.tabCompleted' },
  { value: 'failed', labelKey: 'tasks.tabFailed' },
]
const activeTab = ref<TaskTab>('all')

/** 仅失败页签支持批量处理（14 FR-04）；Tab 切换经 :key 重挂载表格并清空选择 */
const selectable = computed(() => activeTab.value === 'failed')

const externalQuery = computed<Record<string, unknown>>(() => ({
  status: activeTab.value === 'all' ? undefined : activeTab.value,
}))

const filters: FilterField[] = [
  { prop: 'type', labelKey: 'tasks.typeFilter', type: 'select', enumGroup: 'taskType', width: 180 },
]

const newTaskVisible = ref(false)
const transferVisible = ref(false)
const transferIds = ref<string[]>([])
let transferClear: (() => void) | null = null

function formatDateTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : '—'
}

function onRowClick(row: TaskItem) {
  void router.push({ name: 'task-detail', params: { id: row.taskId } })
}

function onSaved() {
  void queryClient.invalidateQueries({ queryKey: qk.tasks.all })
}

/** 批量逐条结果提示（单条失败不阻断其余，14 §3.7） */
async function runBatch(payload: BatchTaskActionReq, clear?: () => void) {
  try {
    const resp = await batchTaskAction(payload)
    if (resp.failed > 0) {
      ElMessage.warning(
        t('tasks.batchResultPartial', { succeeded: resp.succeeded, failed: resp.failed }),
      )
    } else {
      ElMessage.success(t('tasks.batchResultAllDone', { count: resp.succeeded }))
    }
    clear?.()
    await queryClient.invalidateQueries({ queryKey: qk.tasks.all })
  } catch (error) {
    handleApiError(error)
  }
}

async function onBatchRetry(rows: TaskItem[], clear: () => void) {
  const taskIds = rows.map((row) => row.taskId)
  if (taskIds.length === 0) return
  try {
    await ElMessageBox.confirm(t('tasks.batchRetryConfirm', { count: taskIds.length }), {
      type: 'warning',
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
    })
  } catch {
    return
  }
  await runBatch({ action: 'retry', taskIds }, clear)
}

function onBatchTransfer(rows: TaskItem[], clear: () => void) {
  if (rows.length === 0) return
  transferIds.value = rows.map((row) => row.taskId)
  transferClear = clear
  transferVisible.value = true
}

function onTransferSaved() {
  transferClear?.()
  transferClear = null
  onSaved()
}
</script>

<template>
  <div class="tasks">
    <div class="tasks__header">
      <h3 class="tasks__title">{{ t('tasks.title') }}</h3>
      <el-button type="primary" @click="newTaskVisible = true">
        <el-icon><Plus /></el-icon>{{ t('tasks.newTask') }}
      </el-button>
    </div>

    <el-tabs v-model="activeTab" class="tasks__tabs">
      <el-tab-pane
        v-for="tab in tabs"
        :key="tab.value"
        :name="tab.value"
        :label="t(tab.labelKey)"
      />
    </el-tabs>

    <ProTable
      :key="activeTab"
      :columns="columns"
      :fetcher="fetchTasks"
      :query-key-base="qk.tasks.all"
      :filters="filters"
      :external-query="externalQuery"
      :selectable="selectable"
      row-key="taskId"
      @row-click="onRowClick"
    >
      <template #col-progressPct="{ row }">
        <el-progress
          :percentage="row.progressPct"
          :stroke-width="6"
          :status="
            row.status === 'failed'
              ? 'exception'
              : row.status === 'completed'
                ? 'success'
                : undefined
          "
        />
      </template>
      <template #col-createdAt="{ row }">{{ formatDateTime(row.createdAt) }}</template>

      <template #batch="{ rows, clear }">
        <el-button size="small" type="primary" plain @click="onBatchRetry(rows, clear)">
          {{ t('tasks.batchRetry') }}
        </el-button>
        <el-button size="small" type="warning" plain @click="onBatchTransfer(rows, clear)">
          {{ t('tasks.batchTransfer') }}
        </el-button>
      </template>
    </ProTable>

    <NewTaskDialog v-model="newTaskVisible" @saved="onSaved" />
    <TransferToHumanDialog
      v-model="transferVisible"
      :task-ids="transferIds"
      :batch="true"
      @saved="onTransferSaved"
    />
  </div>
</template>

<style scoped lang="scss">
.tasks {
  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: calc(var(--tp-spacing-base) * 2);
  }

  &__title {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__tabs {
    margin-bottom: calc(var(--tp-spacing-base) * 2);
  }
}
</style>
