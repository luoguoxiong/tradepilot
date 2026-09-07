<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import AiStatusTag from '@/components/business/AiStatusTag.vue'
import type { TaskStatus } from '@/api/types/tasks'

/**
 * TaskProgressCard 任务进度卡（04 §2.2）：progressPct + currentStep + 状态标签；
 * SSE 与轮询双源由 useTaskStream 输出统一喂入（presentational）。
 */
const props = withDefaults(
  defineProps<{
    title?: string
    goal?: string
    status: TaskStatus | null
    progressPct: number
    currentStep?: string
    foundCount?: number | null
    targetCount?: number | null
    error?: string | null
    source?: 'idle' | 'sse' | 'polling' | 'done'
  }>(),
  {
    title: undefined,
    goal: undefined,
    currentStep: '',
    foundCount: null,
    targetCount: null,
    error: null,
    source: 'idle',
  },
)

const { t } = useI18n()

const progressLabel = computed(() => {
  if (props.foundCount !== null && props.targetCount) {
    return t('leadGen.progressCount', { found: props.foundCount, target: props.targetCount })
  }
  return `${props.progressPct}%`
})

const sourceText = computed(() => {
  switch (props.source) {
    case 'sse':
      return t('leadGen.sourceSse')
    case 'polling':
      return t('leadGen.sourcePolling')
    case 'done':
      return t('leadGen.sourceDone')
    default:
      return ''
  }
})
</script>

<template>
  <div class="task-progress-card">
    <div class="task-progress-card__header">
      <div class="task-progress-card__title">
        <span v-if="props.title" class="task-progress-card__name">{{ props.title }}</span>
        <AiStatusTag group="taskStatus" :value="props.status" />
      </div>
      <span class="task-progress-card__count">{{ progressLabel }}</span>
    </div>

    <p v-if="props.goal" class="task-progress-card__goal">{{ props.goal }}</p>

    <el-progress
      :percentage="props.progressPct"
      :stroke-width="8"
      :status="
        props.status === 'failed'
          ? 'exception'
          : props.status === 'completed'
            ? 'success'
            : undefined
      "
    />

    <div class="task-progress-card__meta">
      <span v-if="props.currentStep" class="task-progress-card__step">
        {{ props.currentStep }}
      </span>
      <span v-if="sourceText" class="task-progress-card__source">{{ sourceText }}</span>
    </div>

    <el-alert
      v-if="props.error"
      :title="props.error"
      type="error"
      :closable="false"
      class="task-progress-card__error"
    />
  </div>
</template>

<style scoped lang="scss">
.task-progress-card {
  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  &__title {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  &__name {
    font-weight: 600;
    color: var(--tp-text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__count {
    font-size: 13px;
    color: var(--tp-text-secondary);
    white-space: nowrap;
  }

  &__goal {
    margin: 0 0 10px;
    font-size: 13px;
    color: var(--tp-text-tertiary);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  &__meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 8px;
  }

  &__step {
    font-size: 13px;
    color: var(--tp-text-secondary);
  }

  &__source {
    font-size: 12px;
    color: var(--tp-text-tertiary);
    white-space: nowrap;
  }

  &__error {
    margin-top: 10px;
  }
}
</style>
