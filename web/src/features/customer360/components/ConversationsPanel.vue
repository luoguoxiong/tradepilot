<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'

import EmptyState from '@/components/business/EmptyState.vue'
import { getCustomerConversations } from '@/api/resources/customers'
import type { ConversationItem } from '@/api/types/customers'
import type { PageResp } from '@/api/types/common'
import { qk } from '@/query/keys'
import { listQueryOptions } from '@/query/options'
import { DEFAULT_TIMEZONE, formatRelative } from '@/utils/date'

/**
 * ConversationsPanel Conversations 页签（04 §1.5，复用 06）：
 * 会话行（subject/snippet + unread 徽标）；行点击跳 06 对应会话随销售工作台 P1 启用（P0 提示）。
 */
const props = withDefaults(defineProps<{ entityId: string; timezone?: string }>(), {
  timezone: DEFAULT_TIMEZONE,
})

const { t } = useI18n()

const page = ref(1)
const pageSize = 10

const filters = computed(() => ({ page: page.value, pageSize }))

const convQuery = useQuery<PageResp<ConversationItem>>({
  queryKey: computed(() => qk.customer360.conversations(props.entityId, filters.value)),
  queryFn: () => getCustomerConversations(props.entityId, filters.value),
  ...listQueryOptions(),
})

watch(
  () => props.entityId,
  () => {
    page.value = 1
  },
)

const list = computed(() => convQuery.data.value?.items ?? [])
const total = computed(() => convQuery.data.value?.total ?? 0)

function timeText(value: string): string {
  return formatRelative(value)
}
</script>

<template>
  <div class="conversations-panel">
    <el-skeleton v-if="convQuery.isLoading.value" :rows="4" animated />

    <template v-else>
      <div v-if="list.length" class="conversations-panel__list">
        <div v-for="c in list" :key="c.conversationId" class="conversations-panel__item">
          <div class="conversations-panel__main">
            <p class="conversations-panel__subject">
              <el-tooltip :content="t('c360.convWip')" placement="top">
                <span>{{ c.subject }}</span>
              </el-tooltip>
              <el-badge
                v-if="c.unreadCount > 0"
                :value="c.unreadCount"
                class="conversations-panel__badge"
              />
            </p>
            <p class="conversations-panel__snippet">{{ c.lastSnippet || '—' }}</p>
          </div>
          <div class="conversations-panel__meta">
            <span class="conversations-panel__email">{{ c.email }}</span>
            <span class="conversations-panel__time">{{ timeText(c.lastMessageAt) }}</span>
          </div>
        </div>
      </div>
      <EmptyState
        v-else
        class="conversations-panel__empty"
        :title="t('c360.convEmpty')"
        :description="t('c360.convEmptyHint')"
      />

      <el-pagination
        v-if="total > pageSize"
        class="conversations-panel__pager"
        layout="prev, pager, next"
        :total="total"
        :page-size="pageSize"
        :current-page="page"
        @current-change="page = $event"
      />
    </template>
  </div>
</template>

<style scoped lang="scss">
.conversations-panel {
  &__list {
    border: 1px solid var(--tp-border-color);
    border-radius: 8px;
    overflow: hidden;
  }

  &__item {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--tp-border-color);

    &:last-child {
      border-bottom: none;
    }

    &:hover {
      background: color-mix(in srgb, var(--tp-primary) 5%, transparent);
    }
  }

  &__main {
    flex: 1;
    min-width: 0;
  }

  &__subject {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 4px;
    font-weight: 600;
    color: var(--tp-text-primary);
    overflow: hidden;
  }

  &__badge {
    flex-shrink: 0;
  }

  &__snippet {
    margin: 0;
    font-size: 12px;
    color: var(--tp-text-tertiary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__meta {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
    font-size: 12px;
  }

  &__email {
    color: var(--tp-text-secondary);
  }

  &__time {
    color: var(--tp-text-tertiary);
  }

  &__pager {
    margin-top: 14px;
    justify-content: flex-end;
  }

  &__empty {
    padding: 24px 0;
  }
}
</style>
