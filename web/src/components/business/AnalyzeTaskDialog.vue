<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import TaskProgressCard from '@/components/business/TaskProgressCard.vue'
import type { TaskDetail } from '@/api/types/tasks'

/**
 * AnalyzeTaskDialog 客户 360°「AI 分析」进度弹层（04 §3.3）：
 * taskId 轮询 → 复用 TaskProgressCard（progress/currentStep/status），终态后由调用方 invalidate。
 */
const props = withDefaults(
  defineProps<{
    modelValue: boolean
    task?: TaskDetail | null
  }>(),
  { task: null },
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const { t } = useI18n()

const done = computed(() => {
  const status = props.task?.status
  return status === 'completed' || status === 'failed' || status === 'canceled'
})

function close() {
  emit('update:modelValue', false)
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="t('c360.analyzeTitle')"
    width="560px"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    append-to-body
  >
    <el-skeleton v-if="!task" :rows="3" animated />
    <TaskProgressCard
      v-else
      :title="task.title"
      :goal="task.goal"
      :status="task.status"
      :progress-pct="task.progressPct"
      :current-step="task.currentStep"
      :error="task.error"
      :source="done ? 'done' : 'polling'"
    />
    <template #footer>
      <el-button type="primary" :disabled="!done" @click="close">
        {{ t('common.confirm') }}
      </el-button>
    </template>
  </el-dialog>
</template>
