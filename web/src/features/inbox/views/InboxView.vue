<script setup lang="ts">
import { ref, shallowRef } from 'vue'

import type { ConversationListItem } from '@/api/types/conversations'

import SplitPanes from '@/components/common/SplitPanes.vue'
import ConversationListPane from '../components/ConversationListPane.vue'
import ConversationPane from '../components/ConversationPane.vue'
import CopilotPane from '../components/CopilotPane.vue'

defineOptions({ name: 'InboxView' })

/**
 * 06 AI 销售工作台主视图（三栏，02 §2）：
 * - 左：会话列表（四过滤/多邮箱聚合）| 中：消息流 + 草稿编辑 | 右：AI Copilot；
 * - 自研 SplitPanes 嵌套组合三栏，拖拽占比 localStorage 持久化（inbox-left/inbox-right）；
 * - keep-alive 白名单（02 §6）：返回恢复选中会话与过滤态，数据新鲜度由 vue-query staleTime 决定；
 * - Copilot「插入草稿」→ 中栏 composer 合并要点（FR-06 内容型建议）。
 */
const selectedId = ref<string | null>(null)
const selected = shallowRef<ConversationListItem | null>(null)
const convPaneRef = ref<InstanceType<typeof ConversationPane> | null>(null)

function onSelect(item: ConversationListItem): void {
  selected.value = item
  selectedId.value = item.conversationId
}

function onInsertDraft(content: string): void {
  convPaneRef.value?.insertIntoDraft(content)
}
</script>

<template>
  <div class="inbox" data-testid="inbox-view">
    <SplitPanes :initial="[18, 82]" :min="[14, 40]" storage-key="inbox-left">
      <template #pane-0>
        <ConversationListPane :selected-id="selectedId" @select="onSelect" />
      </template>
      <template #pane-1>
        <SplitPanes :initial="[64, 36]" :min="[36, 22]" storage-key="inbox-right">
          <template #pane-0>
            <ConversationPane ref="convPaneRef" :conversation-id="selectedId" />
          </template>
          <template #pane-1>
            <CopilotPane
              :conversation-id="selectedId"
              :conversation="selected"
              @insert-draft="onInsertDraft"
            />
          </template>
        </SplitPanes>
      </template>
    </SplitPanes>
  </div>
</template>

<style scoped lang="scss">
.inbox {
  height: 100%;
  min-height: 0;
}
</style>
