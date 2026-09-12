<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'

import EmptyState from '@/components/business/EmptyState.vue'
import { getFollowUpExecutions } from '@/api/resources/follow-ups'
import type { FollowUpStrategy } from '@/api/types/follow-up'
import { qk } from '@/query/keys'
import { staleTime } from '@/query/options'
import { useDictStore } from '@/stores/dict'
import { formatInOrgTz } from '@/utils/date'

/**
 * 执行记录抽屉（07 FR-05/§3.4）：
 * 每次跟进的执行明细与结果；skipped 记录带 skipReason 留痕
 * （customer_replied 客户回复自动暂停 / frequency_capped 频控顺延留痕）。
 */
const props = defineProps<{
  visible: boolean
  strategy: FollowUpStrategy | null
}>()
const emit = defineEmits<{ 'update:visible': [v: boolean] }>()

const { t } = useI18n()
const dict = useDictStore()

const query = useQuery({
  queryKey: computed(() => qk.followUps.executions(props.strategy?.strategyId ?? '')),
  queryFn: () => getFollowUpExecutions(props.strategy!.strategyId),
  enabled: computed(() => props.visible && Boolean(props.strategy)),
  staleTime: staleTime.DETAIL,
})

const items = computed(() => query.data.value?.items ?? [])
</script>

<template>
  <el-drawer
    :model-value="props.visible"
    :title="t('followUp.executionsTitle', { name: props.strategy?.name ?? '' })"
    size="560px"
    @update:model-value="emit('update:visible', $event)"
  >
    <div v-loading="query.isLoading.value">
      <EmptyState v-if="!query.isLoading.value && items.length === 0" />
      <el-timeline v-else class="exec-timeline">
        <el-timeline-item
          v-for="item in items"
          :key="item.executionId"
          :timestamp="formatInOrgTz(item.sentAt)"
          :type="
            item.status === 'failed' || item.status === 'rejected'
              ? 'danger'
              : item.status === 'sent' || item.status === 'approved'
                ? 'success'
                : item.status === 'waiting_approval'
                  ? 'warning'
                  : 'info'
          "
        >
          <div class="exec-timeline__head">
            <strong>{{ item.stepTitle }}</strong>
            <span
              class="exec-timeline__status"
              :style="{ color: dict.color('executionStatus', item.status) }"
            >
              {{ dict.label('executionStatus', item.status) }}
            </span>
          </div>
          <div v-if="item.skipReason" class="exec-timeline__skip">
            {{ t(`followUp.skipReason.${item.skipReason}`) }}
          </div>
          <div v-if="item.content" class="exec-timeline__content">{{ item.content }}</div>
          <div v-if="item.approvedBy" class="exec-timeline__approver">
            {{ t('followUp.approvedBy', { name: item.approvedBy }) }}
          </div>
        </el-timeline-item>
      </el-timeline>
    </div>
  </el-drawer>
</template>

<style scoped lang="scss">
.exec-timeline {
  padding-left: 4px;

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  &__status {
    font-size: 12px;
    font-weight: 500;
  }

  &__skip {
    margin-top: 4px;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__content {
    margin-top: 4px;
    font-size: 13px;
    color: var(--tp-text-secondary);
    line-height: 1.5;
  }

  &__approver {
    margin-top: 4px;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }
}
</style>
