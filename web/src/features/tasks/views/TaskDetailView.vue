<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useQueryClient } from '@tanstack/vue-query'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowLeft, Link } from '@element-plus/icons-vue'

import EmptyState from '@/components/business/EmptyState.vue'
import AiStatusTag from '@/components/business/AiStatusTag.vue'
import TaskProgressCard from '@/components/business/TaskProgressCard.vue'
import StreamLogPanel from '@/components/business/StreamLogPanel.vue'
import TransferToHumanDialog from '../components/TransferToHumanDialog.vue'
import { useTaskDetail } from '../composables/useTasks'
import { cancelTask, pauseTask, resumeTask, retryTask } from '@/api/resources/tasks'
import { handleApiError } from '@/api/error-handler'
import { notifyWaitingApproval } from '@/features/approvals/composables/notifyWaitingApproval'
import { useTaskStream } from '@/sse/useTaskStream'
import { useDictStore } from '@/stores/dict'
import { qk } from '@/query/keys'
import type { TaskHandoffPayload, TaskOutput, TaskStatus, TaskStep } from '@/api/types/tasks'

/**
 * 14 任务详情（14 §1.2/§2，FR-03/FR-05）：
 * 步骤 + 实时日志 + 产出物，顶部操作（暂停/恢复/取消/重试/转人工），
 * 等待审批的任务一键跳转 AI 审核中心联动处理（14 §3.6）。
 */
defineOptions({ name: 'TaskDetailView' })

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()
const dict = useDictStore()

const taskId = computed(() => String(route.params.id ?? ''))
const { data: detail, isLoading } = useTaskDetail(taskId)

const { state, start } = useTaskStream(taskId, {
  onStatus: (status: TaskStatus, linkedApprovalId?: string) => {
    if (status === 'waiting_approval') notifyWaitingApproval(linkedApprovalId)
  },
  onDone: () => invalidate(),
})
void start()

const acting = ref(false)
const transferVisible = ref(false)

/** 实时状态优先（SSE/轮询），兜底任务详情 */
const status = computed<TaskStatus | null>(() => state.status ?? detail.value?.status ?? null)
const progressPct = computed(() => state.progressPct || detail.value?.progressPct || 0)
const currentStep = computed(() => state.currentStep || detail.value?.currentStep || '')
const error = computed(() => state.error ?? detail.value?.error ?? null)
const linkedApprovalId = computed(
  () => state.linkedApprovalId ?? detail.value?.linkedApprovalId ?? '',
)
const steps = computed<TaskStep[]>(() => detail.value?.steps ?? [])
const outputs = computed<TaskOutput[]>(
  () => (state.outputs ?? detail.value?.outputs ?? []) as TaskOutput[],
)
const handoff = computed<TaskHandoffPayload | null>(() => {
  const item = outputs.value.find((output) => output.type === 'handoff')
  return item ? (item.payload as TaskHandoffPayload) : null
})
const businessOutputs = computed(() => outputs.value.filter((output) => output.type !== 'handoff'))
const hasInput = computed(() => {
  const input = detail.value?.input
  return typeof input === 'object' && input !== null && Object.keys(input).length > 0
})

/** 任务类型 / 产出物类型本地化（dictStore 枚举，未知值原样返回） */
function typeLabel(type: string): string {
  return dict.label('taskType', type)
}

function outputLabel(type: string): string {
  const groups: Record<string, string> = {
    leads: 'tasks.outputType.leads',
    report: 'tasks.outputType.report',
    draft: 'tasks.outputType.draft',
    insight: 'tasks.outputType.insight',
  }
  return groups[type] ? t(groups[type]) : t('tasks.unknownOutput')
}

const canPause = computed(() => status.value === 'running' || status.value === 'scheduled')
const canResume = computed(() => status.value === 'paused')
const canCancel = computed(
  () => status.value === 'running' || status.value === 'scheduled' || status.value === 'paused',
)
const canRetry = computed(() => status.value === 'failed')
const canTransfer = computed(
  () => status.value === 'running' || status.value === 'paused' || status.value === 'failed',
)

const activeStepIndex = computed(() => {
  const index = steps.value.findIndex((step) => step.status === 'running')
  return index >= 0 ? index : steps.value.length
})

function invalidate() {
  void queryClient.invalidateQueries({ queryKey: qk.tasks.all })
}

function formatDateTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : '—'
}

function stepStatus(step: TaskStep): 'wait' | 'process' | 'finish' | 'error' {
  switch (step.status) {
    case 'completed':
      return 'finish'
    case 'running':
      return 'process'
    case 'failed':
      return 'error'
    default:
      return 'wait'
  }
}

function stepTime(step: TaskStep): string {
  const from = step.startedAt ? formatDateTime(step.startedAt) : ''
  const to = step.finishedAt ? formatDateTime(step.finishedAt) : ''
  if (from && to) return `${from} → ${to}`
  return from || to
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
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

async function onPause() {
  if (!(await confirm(t('tasks.pauseConfirm')))) return
  acting.value = true
  try {
    await pauseTask(taskId.value)
    ElMessage.success(t('tasks.pauseSuccess'))
    invalidate()
  } catch (err) {
    handleApiError(err)
  } finally {
    acting.value = false
  }
}

async function onResume() {
  if (!(await confirm(t('tasks.resumeConfirm')))) return
  acting.value = true
  try {
    const resp = await resumeTask(taskId.value)
    ElMessage.success(
      resp.fromCheckpoint ? t('tasks.resumeFromCheckpoint') : t('tasks.resumeSuccess'),
    )
    invalidate()
  } catch (err) {
    handleApiError(err)
  } finally {
    acting.value = false
  }
}

async function onCancel() {
  if (!(await confirm(t('tasks.cancelConfirm')))) return
  acting.value = true
  try {
    await cancelTask(taskId.value)
    ElMessage.success(t('tasks.cancelSuccess'))
    invalidate()
  } catch (err) {
    handleApiError(err)
  } finally {
    acting.value = false
  }
}

async function onRetry() {
  if (!(await confirm(t('tasks.retryConfirm')))) return
  acting.value = true
  try {
    const resp = await retryTask(taskId.value)
    ElMessage.success(t('tasks.retrySuccess'))
    invalidate()
    void router.push({ name: 'task-detail', params: { id: resp.taskId } })
  } catch (err) {
    handleApiError(err)
  } finally {
    acting.value = false
  }
}

function gotoApproval() {
  if (!linkedApprovalId.value) return
  void router.push({ name: 'approvals', query: { approvalId: linkedApprovalId.value } })
}

function back() {
  void router.push({ name: 'tasks' })
}
</script>

<template>
  <div v-loading="isLoading" class="task-detail">
    <template v-if="detail">
      <div class="task-detail__header">
        <div class="task-detail__head-left">
          <el-button link :icon="ArrowLeft" @click="back">{{ t('common.back') }}</el-button>
          <h3 class="task-detail__name">{{ detail.title }}</h3>
          <AiStatusTag group="taskStatus" :value="status" />
        </div>
        <div class="task-detail__actions">
          <el-button v-if="canResume" type="primary" :loading="acting" @click="onResume">
            {{ t('tasks.resume') }}
          </el-button>
          <el-button v-if="canRetry" type="primary" :loading="acting" @click="onRetry">
            {{ t('tasks.retry') }}
          </el-button>
          <el-button v-if="canPause" :loading="acting" @click="onPause">
            {{ t('tasks.pause') }}
          </el-button>
          <el-button v-if="canTransfer" :loading="acting" @click="transferVisible = true">
            {{ t('tasks.transferToHuman') }}
          </el-button>
          <el-button
            v-if="linkedApprovalId"
            type="primary"
            plain
            :icon="Link"
            @click="gotoApproval"
          >
            {{ t('tasks.viewApproval') }}
          </el-button>
          <el-button v-if="canCancel" type="danger" plain :loading="acting" @click="onCancel">
            {{ t('tasks.cancel') }}
          </el-button>
        </div>
      </div>

      <el-alert
        v-if="linkedApprovalId && status === 'waiting_approval'"
        type="warning"
        :closable="false"
        :title="t('tasks.approvalAlert')"
      >
        <template #default>
          <el-button link type="primary" :icon="Link" @click="gotoApproval">
            {{ t('tasks.viewApproval') }}
          </el-button>
        </template>
      </el-alert>

      <!-- 进度卡（SSE / 轮询双源统一喂入） -->
      <TaskProgressCard
        :title="detail.title"
        :goal="detail.goal"
        :status="status"
        :progress-pct="progressPct"
        :current-step="currentStep"
        :error="error"
        :source="state.source"
      />

      <!-- 基本信息 -->
      <div class="task-detail__section">
        <div class="task-detail__section-title">{{ t('tasks.basicInfo') }}</div>
        <el-descriptions :column="3" border size="small">
          <el-descriptions-item :label="t('tasks.employee')">
            {{ detail.employeeName ?? '—' }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('tasks.type')">
            {{ typeLabel(detail.type) }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('tasks.status')">
            <AiStatusTag group="taskStatus" :value="status" />
          </el-descriptions-item>
          <el-descriptions-item :label="t('tasks.currentStep')">
            {{ currentStep || '—' }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('tasks.createdAt')">
            {{ formatDateTime(detail.createdAt) }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('tasks.progress')"
            >{{ progressPct }}%</el-descriptions-item
          >
          <el-descriptions-item :label="t('tasks.startedAt')">
            {{ formatDateTime(detail.startedAt) }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('tasks.finishedAt')">
            {{ formatDateTime(detail.finishedAt) }}
          </el-descriptions-item>
        </el-descriptions>
      </div>

      <el-alert
        v-if="error"
        type="error"
        :closable="false"
        :title="`${t('tasks.errorTitle')}：${error}`"
      />

      <!-- 人工交接摘要 -->
      <div v-if="handoff" class="task-detail__section">
        <div class="task-detail__section-title">{{ t('tasks.handoffTitle') }}</div>
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item :label="t('tasks.handoffFrom')">
            {{ handoff.fromStatus }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('tasks.handoffReason')">
            {{ handoff.reason || '—' }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('tasks.handoffAssignee')">
            {{ handoff.assignee || '—' }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('tasks.handoffAt')">
            {{ formatDateTime(handoff.transferredAt) }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('tasks.handoffSummary')" :span="2">
            {{ handoff.summary || '—' }}
          </el-descriptions-item>
        </el-descriptions>
      </div>

      <div class="task-detail__grid">
        <!-- 执行步骤 -->
        <div class="task-detail__card task-detail__card--steps">
          <div class="task-detail__section-title">{{ t('tasks.steps') }}</div>
          <EmptyState v-if="steps.length === 0" :description="t('tasks.noSteps')" />
          <el-steps v-else direction="vertical" :active="activeStepIndex">
            <el-step
              v-for="(step, index) in steps"
              :key="`${index}-${step.name}`"
              :title="step.name"
              :description="stepTime(step)"
              :status="stepStatus(step)"
            />
          </el-steps>
        </div>

        <!-- 实时日志 -->
        <div class="task-detail__card">
          <div class="task-detail__section-title">{{ t('tasks.logs') }}</div>
          <StreamLogPanel :logs="state.logs" :height="360" />
        </div>
      </div>

      <!-- 产出物 -->
      <div class="task-detail__section">
        <div class="task-detail__section-title">{{ t('tasks.outputs') }}</div>
        <EmptyState v-if="businessOutputs.length === 0" :description="t('tasks.noOutputs')" />
        <div v-else class="task-detail__outputs">
          <div v-for="(output, index) in businessOutputs" :key="index" class="task-detail__output">
            <el-tag size="small" type="info">{{ outputLabel(output.type) }}</el-tag>
            <pre class="task-detail__json">{{ pretty(output.payload) }}</pre>
          </div>
        </div>
      </div>

      <!-- 输入参数 -->
      <div class="task-detail__section">
        <div class="task-detail__section-title">{{ t('tasks.input') }}</div>
        <EmptyState v-if="!hasInput" :description="t('tasks.noInput')" />
        <pre v-else class="task-detail__json">{{ pretty(detail.input) }}</pre>
      </div>

      <TransferToHumanDialog
        v-model="transferVisible"
        :task-ids="[detail.taskId]"
        @saved="invalidate"
      />
    </template>

    <EmptyState v-else-if="!isLoading" :description="t('tasks.notFound')" />
  </div>
</template>

<style scoped lang="scss">
.task-detail {
  display: flex;
  flex-direction: column;
  gap: calc(var(--tp-spacing-base) * 2);

  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }

  &__head-left {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }

  &__name {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  &__section-title {
    margin-bottom: 8px;
    font-size: 14px;
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
    gap: calc(var(--tp-spacing-base) * 2);
  }

  &__card {
    padding: calc(var(--tp-spacing-base) * 1.5);
    border: 1px solid var(--tp-border-color);
    border-radius: var(--tp-radius-base, 8px);

    // 步骤卡：ElPlus 垂直步骤容器默认 height:100%，与 grid 等高拉伸叠加时会被压扁，
    // 导致末步（含时间）溢出到卡片外。
    // 解法：卡片按内容撑高（align-self: start 不参与拉伸）+ 步骤容器取消 height:100%。
    &--steps {
      align-self: start;

      :deep(.el-steps--vertical) {
        height: auto;
      }
    }
  }

  &__outputs {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  &__output {
    padding: 12px;
    border: 1px solid var(--tp-border-light);
    border-radius: var(--tp-radius-base, 8px);
  }

  &__json {
    margin: 8px 0 0;
    padding: 12px;
    max-height: 320px;
    overflow: auto;
    font-size: 12px;
    line-height: 1.6;
    color: var(--tp-text-secondary);
    background: var(--tp-bg-secondary, #fafafa);
    border-radius: var(--tp-radius-base, 8px);
    white-space: pre-wrap;
    word-break: break-word;
  }
}
</style>
