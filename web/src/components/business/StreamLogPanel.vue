<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useVirtualList } from '@vueuse/core'

import EmptyState from '@/components/business/EmptyState.vue'
import { formatRelative } from '@/utils/date'
import type { TaskLog } from '@/api/types/tasks'

/**
 * StreamLogPanel 任务实时日志面板（04 §2.2）：
 * 消费 useTaskStream 的 logs[]：虚拟滚动（>200 条阈值 04 §4）、底部跟随开关、
 * logId 去重（上游保证）、按 type 着色 + 图标、终态收起跟随。
 */
const props = withDefaults(
  defineProps<{
    logs: TaskLog[]
    height?: number
  }>(),
  { height: 320 },
)

const { t } = useI18n()

const follow = ref(true)
const containerStyle = { height: `${props.height}px` }
const { list, containerProps, wrapperProps, scrollTo } = useVirtualList(props.logs, {
  itemHeight: 32,
  overscan: 10,
})

const isEmpty = computed(() => props.logs.length === 0)

// 底部跟随：日志追加时滚动到底（用户手动上滚即暂停跟随）
watch(
  () => props.logs.length,
  async (len, old) => {
    if (len > (old ?? 0) && follow.value && len > 0) {
      scrollTo(props.logs.length - 1)
    }
  },
)

/** 用户滚离底部 → 暂停跟随；滚回底部 → 恢复（近似判定） */
function onScroll(e: Event) {
  const el = e.target as HTMLElement
  follow.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 40
}

const TYPE_META: Record<string, { icon: string; className: string }> = {
  search: { icon: '🔍', className: 'is-search' },
  found: { icon: '✓', className: 'is-found' },
  crawl: { icon: '🌐', className: 'is-crawl' },
  match: { icon: '🧠', className: 'is-match' },
  contact: { icon: '👤', className: 'is-contact' },
  lookup: { icon: '📩', className: 'is-lookup' },
  error: { icon: '⚠️', className: 'is-error' },
}

function meta(type: string) {
  return TYPE_META[type] ?? { icon: '•', className: '' }
}
</script>

<template>
  <div class="stream-log-panel">
    <div class="stream-log-panel__toolbar">
      <span class="stream-log-panel__count">
        {{ t('leadGen.logCount', { count: props.logs.length }) }}
      </span>
      <el-checkbox v-model="follow" size="small">
        {{ t('leadGen.followBottom') }}
      </el-checkbox>
    </div>

    <EmptyState v-if="isEmpty" :description="t('leadGen.logEmpty')" />

    <div
      v-else
      v-bind="containerProps"
      class="stream-log-panel__list"
      :style="containerStyle"
      @scroll.passive="onScroll"
    >
      <div v-bind="wrapperProps">
        <div
          v-for="{ data } in list"
          :key="data.logId"
          class="stream-log-panel__row"
          :class="meta(data.type).className"
        >
          <span class="stream-log-panel__icon">{{ meta(data.type).icon }}</span>
          <span class="stream-log-panel__time">{{ formatRelative(data.time) }}</span>
          <span class="stream-log-panel__content" :title="data.content">{{ data.content }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.stream-log-panel {
  &__toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  &__count {
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__list {
    overflow: auto;
    border: 1px solid var(--tp-border-light);
    border-radius: var(--tp-radius-base, 8px);
    background: var(--tp-bg-secondary, #fafafa);
  }

  &__row {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 12px;
    font-size: 13px;
    line-height: 32px;
  }

  &__icon {
    flex-shrink: 0;
    width: 18px;
    text-align: center;
  }

  &__time {
    flex-shrink: 0;
    width: 72px;
    color: var(--tp-text-tertiary);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &__content {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--tp-text-primary);
  }

  &__row.is-error .stream-log-panel__content {
    color: var(--ai-risk);
    font-weight: 500;
  }

  &__row.is-found .stream-log-panel__content {
    color: var(--ai-working);
  }

  &__row.is-match .stream-log-panel__content {
    color: var(--ai-scheduled);
  }
}
</style>
