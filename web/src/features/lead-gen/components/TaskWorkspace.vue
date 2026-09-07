<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQueryClient } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'

import TaskProgressCard from '@/components/business/TaskProgressCard.vue'
import StreamLogPanel from '@/components/business/StreamLogPanel.vue'
import { notifyWaitingApproval } from '@/features/approvals/composables/notifyWaitingApproval'
import { useTaskStream } from '@/sse/useTaskStream'
import { qk } from '@/query/keys'
import type { TaskStatus } from '@/api/types/tasks'

/**
 * TaskWorkspace 任务工作台（04 §2.2 / 排期 M3-3）：
 * TaskProgressCard + StreamLogPanel 常驻组合，useTaskStream 驱动
 * （SSE 主链路 + 断线降级轮询，UI 无感）；done 终态回调 invalidate 任务相关 query。
 * 03 获客工作台与 02 员工中心任务抽屉复用。
 */
const props = withDefaults(
  defineProps<{
    taskId: string
    /** 进度卡标题 */
    title?: string
    /** 目标描述行 */
    goal?: string
    /** 日志面板高度 */
    logHeight?: number
    /** done 后额外失效的 query key 前缀（如发现列表） */
    invalidateOnDone?: readonly (readonly unknown[])[]
  }>(),
  { title: undefined, goal: undefined, logHeight: 360, invalidateOnDone: () => [] },
)

const { t } = useI18n()
const queryClient = useQueryClient()

function invalidateTaskQueries() {
  void queryClient.invalidateQueries({ queryKey: qk.tasks.all })
  for (const key of props.invalidateOnDone) {
    void queryClient.invalidateQueries({ queryKey: key })
  }
}

const taskIdRef = computed(() => props.taskId)

const { state, start } = useTaskStream(taskIdRef, {
  // waiting_approval → 全局通知 + 铃徽标刷新（M5 决策 10，点击深链审核中心）
  onStatus: (status: TaskStatus, linkedApprovalId?: string) => {
    if (status === 'waiting_approval') notifyWaitingApproval(linkedApprovalId)
  },
  onDone: (status: TaskStatus) => {
    invalidateTaskQueries()
    if (status === 'completed') ElMessage.success(t('leadGen.taskDone'))
    else if (status === 'failed') ElMessage.error(t('leadGen.taskFailed'))
  },
})

// 挂载即开流（切任务由父组件以 :key 重挂载实现，stop 语义由 useTaskStream 作用域销毁兜底）
void start()

const finished = computed(() => state.source === 'done')
</script>

<template>
  <div class="task-workspace">
    <TaskProgressCard
      :title="props.title"
      :goal="props.goal"
      :status="state.status"
      :progress-pct="state.progressPct"
      :current-step="state.currentStep"
      :found-count="state.foundCount"
      :target-count="state.targetCount"
      :error="state.error"
      :source="state.source"
    />
    <StreamLogPanel :logs="state.logs" :height="props.logHeight" />
    <div v-if="finished" class="task-workspace__footer">
      <slot name="done" />
    </div>
  </div>
</template>

<style scoped lang="scss">
.task-workspace {
  &__footer {
    display: flex;
    justify-content: flex-end;
    margin-top: 12px;
  }
}
</style>
