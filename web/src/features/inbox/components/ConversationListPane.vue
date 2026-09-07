<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { Search } from '@element-plus/icons-vue'

import type {
  ConversationListItem,
  ConversationListReq,
  ConversationPriority,
} from '@/api/types/conversations'
import { fetchConversations } from '@/api/resources/conversations'
import { fetchMailboxes } from '@/api/resources/settings'
import { formatRelative } from '@/utils/date'
import { qk } from '@/query/keys'
import { staleTime } from '@/query/options'

/**
 * 会话列表 Pane（06 §2 左栏 / FR-01/FR-11）：
 * - 四过滤：关键词 / 优先级 / 仅未读 / 邮箱来源（多邮箱聚合下拉）；
 * - 行样式：高优红条 + 未读加粗圆点 + 相对时间；
 * - 数据经 vue-query，选中态由父组件 props.selectedId 同步。
 */
const props = defineProps<{
  selectedId: string | null
}>()

const emit = defineEmits<{
  select: [item: ConversationListItem]
}>()

const { t } = useI18n()

// ===== 过滤态 =====
const keyword = ref('')
const priority = ref<ConversationPriority | ''>('')
const unreadOnly = ref(false)
const mailboxId = ref('')

const filters = computed<ConversationListReq>(() => ({
  keyword: keyword.value || undefined,
  priority: (priority.value || undefined) as ConversationListReq['priority'],
  unreadOnly: unreadOnly.value || undefined,
  mailboxId: mailboxId.value || undefined,
  pageSize: 50,
}))

const listQuery = useQuery({
  queryKey: computed(() => qk.conversations.list(filters.value)),
  queryFn: () => fetchConversations(filters.value),
  select: (data) => data.list,
})

const items = computed(() => listQuery.data.value ?? [])

// ===== 邮箱来源选项（FR-11 多邮箱聚合） =====
const mailboxesQuery = useQuery({
  queryKey: qk.mailboxes,
  queryFn: fetchMailboxes,
  staleTime: staleTime.DICT,
})

const priorityTagType: Record<ConversationPriority, 'danger' | 'primary' | 'warning'> = {
  high: 'danger',
  normal: 'primary',
  pending: 'warning',
}

function onSelect(row: ConversationListItem): void {
  emit('select', row)
}
</script>

<template>
  <aside class="conv-list" data-testid="conversation-list">
    <header class="conv-list__head">
      <h3 class="conv-list__title">{{ t('inbox.title') }}</h3>
      <el-badge v-if="items.length" :value="items.length" type="info" :max="99" />
    </header>

    <div class="conv-list__filters">
      <el-input
        v-model="keyword"
        :placeholder="t('inbox.searchPlaceholder')"
        :prefix-icon="Search"
        clearable
        size="small"
        data-testid="conv-search"
      />
      <div class="conv-list__filter-row">
        <el-select
          v-model="priority"
          size="small"
          :placeholder="t('inbox.allPriorities')"
          clearable
          class="conv-list__filter-priority"
        >
          <el-option :label="`🔥 ${t('inbox.priority.high')}`" value="high" />
          <el-option :label="`🟢 ${t('inbox.priority.normal')}`" value="normal" />
          <el-option :label="`🟡 ${t('inbox.priority.pending')}`" value="pending" />
        </el-select>
        <el-select
          v-model="mailboxId"
          size="small"
          :placeholder="t('inbox.allMailboxes')"
          clearable
          class="conv-list__filter-mailbox"
        >
          <el-option
            v-for="mb in mailboxesQuery.data.value ?? []"
            :key="mb.mailboxId"
            :label="mb.account"
            :value="mb.mailboxId"
          />
        </el-select>
        <el-checkbox
          v-model="unreadOnly"
          :label="t('inbox.unreadOnly')"
          size="small"
          class="conv-list__unread-switch"
        />
      </div>
    </div>

    <div v-loading="listQuery.isLoading.value" class="conv-list__scroll">
      <button
        v-for="row in items"
        :key="row.conversationId"
        type="button"
        class="conv-list__item"
        :class="{
          'conv-list__item--active': row.conversationId === props.selectedId,
          'conv-list__item--high': row.priority === 'high',
        }"
        data-testid="conversation-item"
        @click="onSelect(row)"
      >
        <div class="conv-list__item-top">
          <span class="conv-list__company" :class="{ 'is-unread': row.unreadCount > 0 }">
            {{ row.companyName }}
          </span>
          <span class="conv-list__time">{{ formatRelative(row.lastMessageAt) }}</span>
        </div>
        <div class="conv-list__item-mid">
          <span class="conv-list__contact">{{ row.contactName }}</span>
          <el-tag :type="priorityTagType[row.priority]" size="small" effect="light" round>
            {{ t(`inbox.priority.${row.priority}`) }}
          </el-tag>
          <el-tag v-if="row.mailboxId" size="small" type="info" effect="plain" class="conv-list__mailbox">
            {{ row.mailboxId }}
          </el-tag>
        </div>
        <div class="conv-list__item-bottom">
          <span class="conv-list__preview">{{ row.lastMessagePreview }}</span>
          <span v-if="row.unreadCount > 0" class="conv-list__unread" data-testid="unread-badge">
            {{ row.unreadCount }}
          </span>
        </div>
      </button>

      <el-empty
        v-if="!listQuery.isLoading.value && items.length === 0"
        :description="t('inbox.emptyConversations')"
        :image-size="72"
      />
    </div>
  </aside>
</template>

<style scoped lang="scss">
.conv-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  border-right: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color);

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px 8px;
  }

  &__title {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }

  &__filters {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 0 12px 10px;
    border-bottom: 1px solid var(--el-border-color-lighter);
  }

  &__filter-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  &__filter-priority {
    width: 112px;
  }

  &__filter-mailbox {
    flex: 1;
    min-width: 0;
  }

  &__unread-switch {
    flex-shrink: 0;
    white-space: nowrap;

    :deep(.el-checkbox__label) {
      font-size: 12px;
      padding-left: 4px;
    }
  }

  &__scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  &__item {
    display: block;
    width: 100%;
    padding: 10px 14px;
    border: none;
    border-bottom: 1px solid var(--el-border-color-extra-light);
    border-left: 3px solid transparent;
    background: transparent;
    text-align: left;
    cursor: pointer;
    transition: background 0.15s;

    &:hover {
      background: var(--el-fill-color-light);
    }

    &--active {
      background: var(--el-color-primary-light-9);
      border-left-color: var(--el-color-primary);
    }

    &--high:not(&--active) {
      border-left-color: var(--el-color-danger-light-5);
    }
  }

  &__item-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  &__company {
    overflow: hidden;
    font-size: 14px;
    color: var(--el-text-color-primary);
    text-overflow: ellipsis;
    white-space: nowrap;

    &.is-unread {
      font-weight: 600;
    }
  }

  &__time {
    flex-shrink: 0;
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }

  &__item-mid {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 3px;
  }

  &__contact {
    overflow: hidden;
    font-size: 12px;
    color: var(--el-text-color-regular);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__mailbox {
    flex-shrink: 0;
    margin-left: auto;
    max-width: 90px;
  }

  &__item-bottom {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
  }

  &__preview {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-size: 12px;
    color: var(--el-text-color-secondary);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__unread {
    flex-shrink: 0;
    min-width: 18px;
    padding: 0 5px;
    border-radius: 9px;
    background: var(--el-color-danger);
    color: #fff;
    font-size: 11px;
    line-height: 18px;
    text-align: center;
  }
}
</style>
