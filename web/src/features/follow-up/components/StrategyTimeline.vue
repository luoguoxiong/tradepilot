<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'

import { getFollowUpExecutions } from '@/api/resources/follow-ups'
import type { FollowUpStrategy, StrategyStepRunStatus } from '@/api/types/follow-up'
import { qk } from '@/query/keys'
import { staleTime } from '@/query/options'

/**
 * 策略时间线（07 FR-03）：
 * Day 0 → … → Break-up 节点纵列；节点状态按执行记录派生——
 * done ✓（已有终态执行）/ running ⏳（等待审核）/ pending ○（未开始）。
 */
const props = defineProps<{ strategy: FollowUpStrategy }>()

const { t } = useI18n()

const executionsQuery = useQuery({
  queryKey: computed(() => qk.followUps.executions(props.strategy.strategyId)),
  queryFn: () => getFollowUpExecutions(props.strategy.strategyId),
  staleTime: staleTime.DETAIL,
})

const statuses = computed<Record<string, StrategyStepRunStatus>>(() => {
  const items = executionsQuery.data.value?.list ?? []
  const map: Record<string, StrategyStepRunStatus> = {}
  for (const execution of items) {
    const current = map[execution.stepTitle]
    if (current === 'done') continue
    if (execution.status === 'waiting_approval') map[execution.stepTitle] = 'running'
    else map[execution.stepTitle] = 'done'
  }
  return map
})

function statusOf(title: string): StrategyStepRunStatus {
  return statuses.value[title] ?? 'pending'
}
</script>

<template>
  <ul class="timeline">
    <li v-for="step in props.strategy.steps" :key="step.seq" class="timeline__step">
      <span class="timeline__day">Day {{ step.dayOffset }}</span>
      <span
        class="timeline__mark"
        :class="`timeline__mark--${statusOf(step.title)}`"
        :title="t(`followUp.stepStatus.${statusOf(step.title)}`)"
      >
        {{ statusOf(step.title) === 'done' ? '✓' : statusOf(step.title) === 'running' ? '⏳' : '○' }}
      </span>
      <span class="timeline__title">
        {{ step.title }}
        <el-tag v-if="step.isBreakup" type="danger" size="small" effect="plain">
          {{ t('followUp.breakupTag') }}
        </el-tag>
      </span>
    </li>
  </ul>
</template>

<style scoped lang="scss">
.timeline {
  margin: 0;
  padding: 0;
  list-style: none;

  &__step {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 0;
    border-bottom: 1px dashed var(--tp-border-color);

    &:last-child {
      border-bottom: none;
    }
  }

  &__day {
    width: 64px;
    flex-shrink: 0;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__mark {
    width: 20px;
    text-align: center;

    &--done {
      color: var(--ai-working);
    }

    &--running {
      color: var(--ai-waiting);
    }

    &--pending {
      color: var(--tp-text-tertiary);
    }
  }

  &__title {
    font-size: 13px;
    color: var(--tp-text-primary);
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
}
</style>
