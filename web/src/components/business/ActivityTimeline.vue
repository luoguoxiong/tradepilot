<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import type { ActivityItem } from '@/api/types/customers'
import EmptyState from '@/components/business/EmptyState.vue'
import { ENUMS } from '@/utils/enum-map'
import { DEFAULT_TIMEZONE, formatInOrgTz } from '@/utils/date'

/**
 * ActivityTimeline 活动时间线（04 §1.5 / §3.1）：summary 主线 + type/operator/time 元信息。
 * 类型标签与语义色复用 enums.activityType 注册表（05 §1.3 同口径）；
 * 条目导航（ref_type + ref_id → 06/09/10 业务详情）随对应模块 P1 交付后由调用方开启。
 */
const props = withDefaults(
  defineProps<{
    items: ActivityItem[]
    loading?: boolean
    timezone?: string
  }>(),
  { loading: false, timezone: DEFAULT_TIMEZONE },
)

const { t } = useI18n()

function typeOption(type: ActivityItem['type']) {
  return ENUMS.activityType.find((o) => o.value === type)
}

const visibleItems = computed(() =>
  props.items.map((item) => {
    const opt = typeOption(item.type)
    return {
      ...item,
      typeLabel: opt ? t(opt.labelKey) : item.type,
      typeColor: opt?.color ?? 'var(--tp-text-tertiary)',
    }
  }),
)

function formatTime(value: string): string {
  return formatInOrgTz(value, props.timezone, 'YYYY-MM-DD HH:mm')
}
</script>

<template>
  <div class="activity-timeline">
    <el-skeleton v-if="props.loading && items.length === 0" :rows="4" animated />
    <ul v-else-if="items.length" class="activity-timeline__list">
      <li v-for="item in visibleItems" :key="item.activityId" class="activity-timeline__item">
        <span
          class="activity-timeline__dot"
          :style="{ background: item.typeColor }"
          :title="item.typeLabel"
        />
        <div class="activity-timeline__body">
          <p class="activity-timeline__summary">{{ item.summary }}</p>
          <p class="activity-timeline__meta">
            <el-tag size="small" effect="plain" class="activity-timeline__type">
              {{ item.typeLabel }}
            </el-tag>
            <span v-if="item.operatorType === 'ai'" class="activity-timeline__ai">
              {{ t('crm.operatorAi') }} · {{ item.operatorName }}
            </span>
            <span v-else class="activity-timeline__user">
              {{ t('crm.operatorUser') }} · {{ item.operatorName }}
            </span>
            <span class="activity-timeline__time">{{ formatTime(item.createdAt) }}</span>
          </p>
        </div>
      </li>
    </ul>
    <EmptyState v-else />
  </div>
</template>

<style scoped lang="scss">
.activity-timeline {
  &__list {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  &__item {
    position: relative;
    display: flex;
    gap: 12px;
    padding: 0 0 18px 4px;

    &:last-child {
      padding-bottom: 0;
    }
  }

  &__dot {
    flex-shrink: 0;
    width: 10px;
    height: 10px;
    margin-top: 5px;
    border-radius: 50%;
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--tp-bg-hover) 60%, transparent);
  }

  &__body {
    flex: 1;
    min-width: 0;
  }

  &__summary {
    margin: 0 0 6px;
    line-height: 1.5;
    color: var(--tp-text-primary);
    word-break: break-word;
  }

  &__meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__type {
    margin-right: 2px;
  }

  &__ai {
    color: var(--ai-scheduled);
  }

  &__time {
    margin-left: auto;
  }
}
</style>
