<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useQueryClient } from '@tanstack/vue-query'
import { ArrowLeft } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import ProTable from '@/components/business/ProTable.vue'
import TaskWorkspace from '@/features/lead-gen/components/TaskWorkspace.vue'
import TransferToHumanDialog from '@/features/tasks/components/TransferToHumanDialog.vue'
import { fetchTasks } from '@/features/tasks/composables/useTasks'
import { resumeTask, retryTask } from '@/api/resources/tasks'
import { handleApiError } from '@/api/error-handler'
import { qk } from '@/query/keys'
import type { TaskItem, TaskStatus, TaskTab } from '@/api/types/tasks'
import type { ProColumn } from '@/components/business/pro-table'

/**
 * 02 FR-04 员工「完整任务列表」抽屉（P1-02-03，替代卡片上的轻量摘要）。
 *
 * 卡片只承载「当前任务」轻量对象（P0 口径），完整列表 / 日志 / 重试恢复操作在 14 已具备：
 * 本抽屉按 `employeeId` 复用 14 的同一 `GET /tasks` 列表能力（状态页签 / 分页 / 类型字典 / 行内操作），
 * 避免另起一套任务视图导致两页口径漂移（02 §3.2 / 13 §4 红线）：
 * - 行点击 → 就地展开 TaskWorkspace（进度卡 + 实时日志，SSE）；
 * - 行内操作：失败重试 / 暂停恢复 / 转人工（14 §3.5/§3.6 同接口）；
 * - 「详情」→ 14 任务详情页（步骤 / 产出物 / 输入参数）。
 */
const props = defineProps<{
  modelValue: boolean
  employeeId: string
  employeeName: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const { t } = useI18n()
const router = useRouter()
const queryClient = useQueryClient()

const columns: ProColumn[] = [
  { prop: 'title', labelKey: 'tasks.task', minWidth: 200 },
  { prop: 'type', labelKey: 'tasks.type', width: 120, enumGroup: 'taskType' },
  { prop: 'status', labelKey: 'tasks.status', width: 110, enumGroup: 'taskStatus' },
  { prop: 'progressPct', labelKey: 'tasks.progress', width: 140 },
  { prop: 'createdAt', labelKey: 'tasks.createdAt', width: 170 },
  { prop: 'actions', labelKey: 'common.actions', width: 210, align: 'right' },
]

/** 状态页签（与 14 列表同集合，14 FR-01） */
const tabs: { value: TaskTab; labelKey: string }[] = [
  { value: 'all', labelKey: 'tasks.tabAll' },
  { value: 'running', labelKey: 'tasks.tabRunning' },
  { value: 'waiting_approval', labelKey: 'tasks.tabWaitingApproval' },
  { value: 'completed', labelKey: 'tasks.tabCompleted' },
  { value: 'failed', labelKey: 'tasks.tabFailed' },
]
const activeTab = ref<TaskTab>('all')

/** 仅员工维度过滤：切换页签经 :key 重挂载表格，回到第一页 */
const externalQuery = computed<Record<string, unknown>>(() => ({
  employeeId: props.employeeId,
  status: activeTab.value === 'all' ? undefined : activeTab.value,
}))

/** 就地日志视图：选中任务 → TaskWorkspace（返回列表清空） */
const selectedTaskId = ref<string | null>(null)

const actingId = ref<string | null>(null)
const transferVisible = ref(false)
const transferTaskId = ref<string | null>(null)

const drawerTitle = computed(() =>
  t('employees.taskListTitle', { name: props.employeeName || t('employees.title') }),
)

function formatDateTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : '—'
}

const canTransfer = (status: TaskStatus) =>
  status === 'running' || status === 'paused' || status === 'failed'

function onRowClick(row: TaskItem) {
  selectedTaskId.value = row.taskId
}

function onVisibility(value: boolean) {
  if (!value) {
    selectedTaskId.value = null
    actingId.value = null
  }
  emit('update:modelValue', value)
}

function invalidate() {
  void queryClient.invalidateQueries({ queryKey: qk.tasks.all })
}

async function confirm(message: string): Promise<boolean> {
  try {
    await ElMessageBox.confirm(message, {
      type: 'warning',
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
    })
    return true
  } catch {
    return false
  }
}

async function onRetry(row: TaskItem) {
  if (!(await confirm(t('tasks.retryConfirm')))) return
  actingId.value = row.taskId
  try {
    await retryTask(row.taskId)
    ElMessage.success(t('tasks.retrySuccess'))
    invalidate()
  } catch (error) {
    handleApiError(error)
  } finally {
    actingId.value = null
  }
}

async function onResume(row: TaskItem) {
  if (!(await confirm(t('tasks.resumeConfirm')))) return
  actingId.value = row.taskId
  try {
    const resp = await resumeTask(row.taskId)
    ElMessage.success(
      resp.fromCheckpoint ? t('tasks.resumeFromCheckpoint') : t('tasks.resumeSuccess'),
    )
    invalidate()
  } catch (error) {
    handleApiError(error)
  } finally {
    actingId.value = null
  }
}

function onTransfer(row: TaskItem) {
  transferTaskId.value = row.taskId
  transferVisible.value = true
}

/**
 * 跳转任务详情。
 * 注意：el-table 列探测（TableColumnRenderer）会用空对象 row 调一次列插槽，
 * 因此这里必须做 taskId 兜底，避免 router.push 抛 "Missing required param id"。
 */
function onDetail(row: TaskItem) {
  if (!row.taskId) return
  void router.push({ name: 'task-detail', params: { id: row.taskId } })
}

function onTransferSaved() {
  transferTaskId.value = null
  invalidate()
}
</script>

<template>
  <el-drawer
    :model-value="modelValue"
    :title="drawerTitle"
    size="760px"
    destroy-on-close
    @update:model-value="onVisibility"
  >
    <!-- 日志视图（就地展开，避免跳出员工页上下文） -->
    <div v-if="selectedTaskId" class="employee-tasks__detail">
      <el-button link :icon="ArrowLeft" @click="selectedTaskId = null">
        {{ t('common.back') }}
      </el-button>
      <TaskWorkspace
        :key="selectedTaskId"
        :task-id="selectedTaskId"
        :log-height="420"
        :invalidate-on-done="[qk.tasks.all]"
      />
    </div>

    <!-- 完整任务列表 -->
    <template v-else>
      <el-tabs v-model="activeTab">
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
        :external-query="externalQuery"
        :searchable="false"
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
        <template #col-actions="{ row }">
          <el-button
            v-if="row.status === 'failed'"
            link
            type="primary"
            size="small"
            :loading="actingId === row.taskId"
            @click.stop="onRetry(row)"
          >
            {{ t('tasks.retry') }}
          </el-button>
          <el-button
            v-if="row.status === 'paused'"
            link
            type="primary"
            size="small"
            :loading="actingId === row.taskId"
            @click.stop="onResume(row)"
          >
            {{ t('tasks.resume') }}
          </el-button>
          <el-button
            v-if="canTransfer(row.status)"
            link
            type="warning"
            size="small"
            @click.stop="onTransfer(row)"
          >
            {{ t('tasks.transferToHuman') }}
          </el-button>
          <el-button v-if="row.taskId" link type="primary" size="small" @click.stop="onDetail(row)">
            {{ t('tasks.detailTitle') }}
          </el-button>
        </template>
      </ProTable>
    </template>

    <TransferToHumanDialog
      v-model="transferVisible"
      :task-ids="transferTaskId ? [transferTaskId] : []"
      @saved="onTransferSaved"
    />
  </el-drawer>
</template>

<style scoped lang="scss">
.employee-tasks {
  &__detail {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
}
</style>
