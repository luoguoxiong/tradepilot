<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import { Clock } from '@element-plus/icons-vue'

import type { ConversationMessage } from '@/api/types/conversations'
import { fetchConversationDetail } from '@/api/resources/conversations'
import { ENUMS } from '@/utils/enum-map'
import { formatInOrgTz } from '@/utils/date'
import { qk } from '@/query/keys'

import DraftComposer from './DraftComposer.vue'
import MailHtmlFrame from './MailHtmlFrame.vue'

/**
 * 会话消息 Pane（06 §2 中栏 / §1.2 消息流）：
 * - 头部：客户/联系人/阶段 + 客户 360° 跳转入口；
 * - 消息流：in 左 / out 右气泡，MailHtmlFrame 沙箱渲染正文；
 * - 状态语义：draft（可编辑草稿）/ waiting_approval（12 联动态，跳审核中心）/ failed；
 * - 草稿操作区由 B3 DraftEditor 接管（generateDraft/editDraft 事件上抛）。
 */
const props = defineProps<{
  conversationId: string | null
}>()

const { t } = useI18n()
const router = useRouter()
const route = useRoute()

const detailQuery = useQuery({
  queryKey: computed(() => qk.conversations.detail(props.conversationId ?? '')),
  queryFn: () => fetchConversationDetail(props.conversationId ?? ''),
  enabled: computed(() => !!props.conversationId),
})

const detail = computed(() => detailQuery.data.value ?? null)

const stageText = computed(() => {
  const stage = detail.value?.stage
  if (!stage) return ''
  const option = ENUMS.customerStage.find((o) => o.value === stage)
  return option ? t(option.labelKey) : stage
})

function messageTime(message: ConversationMessage): string {
  return formatInOrgTz(message.sentAt)
}

function openCustomer(): void {
  if (detail.value) void router.push(`/customers/${detail.value.customerId}`)
}

function openApproval(approvalId: string): void {
  void router.push({ path: '/approvals', query: { approvalId, from: route.path } })
}

/** Copilot「插入草稿」转发（InboxView 调用） */
const composerRef = ref<InstanceType<typeof DraftComposer> | null>(null)

function insertIntoDraft(content: string): void {
  composerRef.value?.insertContent(content)
}

defineExpose({ insertIntoDraft })
</script>

<template>
  <section class="conv-pane" data-testid="conversation-pane">
    <template v-if="detail">
      <header class="conv-pane__head">
        <div class="conv-pane__head-main">
          <el-link type="primary" :underline="false" class="conv-pane__company" @click="openCustomer">
            {{ detail.companyName }}
          </el-link>
          <span class="conv-pane__contact">{{ detail.contactName }}</span>
          <el-tag size="small" effect="plain">{{ stageText }}</el-tag>
        </div>
      </header>

      <div class="conv-pane__scroll">
        <div
          v-for="message in detail.messages"
          :key="message.messageId"
          class="conv-pane__row"
          :class="`conv-pane__row--${message.direction}`"
        >
          <div class="conv-pane__bubble-wrap">
            <div class="conv-pane__meta">
              <span class="conv-pane__sender">{{ message.senderName }}</span>
              <span class="conv-pane__time">{{ messageTime(message) }}</span>
              <el-tag v-if="message.language" size="small" effect="plain" type="info">
                {{ message.language.toUpperCase() }}
              </el-tag>
              <el-tag v-if="message.status === 'draft'" size="small" type="warning" effect="light">
                {{ t('inbox.status.draft') }}
              </el-tag>
              <el-tag
                v-else-if="message.status === 'waiting_approval'"
                size="small"
                type="warning"
                effect="light"
                data-testid="waiting-approval-tag"
              >
                {{ t('inbox.status.waitingApproval') }}
              </el-tag>
              <el-tag v-else-if="message.status === 'failed'" size="small" type="danger" effect="light">
                {{ t('inbox.status.failed') }}
              </el-tag>
            </div>

            <div class="conv-pane__bubble" :class="`conv-pane__bubble--${message.direction}`">
              <MailHtmlFrame plain :content="message.content" min-height="48px" />
            </div>

            <div
              v-if="message.status === 'waiting_approval' && message.approvalId"
              class="conv-pane__approval"
              data-testid="waiting-approval-strip"
            >
              <el-icon><Clock /></el-icon>
              <span>{{ t('inbox.waitingApprovalTip') }}</span>
              <el-button link type="primary" size="small" @click="openApproval(message.approvalId)">
                {{ t('inbox.gotoApprovals') }}
              </el-button>
            </div>
          </div>
        </div>

        <el-empty
          v-if="detail.messages.length === 0"
          :description="t('inbox.emptyMessages')"
          :image-size="72"
        />
      </div>

      <!-- 草稿操作区：生成/编辑/保存/发送双分支 -->
      <DraftComposer v-if="detail" ref="composerRef" :detail="detail" />
    </template>

    <el-empty v-else :description="t('inbox.selectConversation')" :image-size="96" class="conv-pane__empty" />
  </section>
</template>

<style scoped lang="scss">
.conv-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--el-bg-color);

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    border-bottom: 1px solid var(--el-border-color-lighter);
  }

  &__head-main {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  &__company {
    font-size: 15px;
    font-weight: 600;
  }

  &__contact {
    font-size: 13px;
    color: var(--el-text-color-secondary);
  }

  &__scroll {
    flex: 1;
    min-height: 0;
    padding: 16px;
    overflow-y: auto;
  }

  &__row {
    display: flex;
    margin-bottom: 16px;

    &--in {
      justify-content: flex-start;
    }

    &--out {
      justify-content: flex-end;
    }
  }

  &__bubble-wrap {
    max-width: min(640px, 86%);
    min-width: 0;
  }

  &__meta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }

  &__sender {
    font-size: 12px;
    font-weight: 500;
    color: var(--el-text-color-regular);
  }

  &__time {
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }

  &__bubble {
    padding: 10px 12px;
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 8px;
    background: var(--el-fill-color-blank);
    overflow: hidden;

    &--in {
      border-top-left-radius: 2px;
    }

    &--out {
      border-top-right-radius: 2px;
      background: var(--el-color-primary-light-9);
    }
  }

  &__approval {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
    padding: 6px 10px;
    border: 1px solid var(--el-color-warning-light-5);
    border-radius: 6px;
    background: var(--el-color-warning-light-9);
    font-size: 12px;
    color: var(--el-text-color-regular);
  }

  &__empty {
    margin: auto;
  }
}
</style>
