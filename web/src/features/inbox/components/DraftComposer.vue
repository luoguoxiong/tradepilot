<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'
import { ChatDotRound, Document, Promotion, RefreshRight } from '@element-plus/icons-vue'

import CitationPopover from '@/components/business/CitationPopover.vue'

import type { AiDraft, ConversationDetail, SendResp } from '@/api/types/conversations'
import type { InsightCitation } from '@/api/types/insight'
import {
  generateAiDraft,
  regenerateAiDraft,
  sendMessage,
  updateMessage,
} from '@/api/resources/conversations'
import type { ApiError } from '@/api/http'
import { handleApiError } from '@/api/error-handler'
import { notifyWaitingApproval } from '@/features/approvals/composables/notifyWaitingApproval'
import { qk } from '@/query/keys'

import DraftEditor from './DraftEditor.vue'

/**
 * 草稿操作区（06 §2 中栏 composer / §3.2/§3.3）：
 * - AI 生成 / 重新生成：basedOnMessageId = 最近一条客户来信；missingKnowledge（D9）黄条提示补资料；
 * - 编辑草稿：DraftEditor 纯文本双向绑定，保存走 PUT /messages/{id}；
 * - 发送双分支（06 §3.3）：分支 A 直发成功；分支 B → 审批单生成，消息置 waiting_approval，
 *   notifyWaitingApproval 全局提醒 + 深链审核中心（12 联动，审批域/徽标统一失效）。
 */
const props = defineProps<{
  detail: ConversationDetail | null
}>()

const { t } = useI18n()
const router = useRouter()
const queryClient = useQueryClient()

// ===== 草稿状态 =====
const draftId = ref<string | null>(null)
const draftContent = ref('')
const generating = ref(false)

/** D9 依据区：当前草稿的知识中心引用；grounded=false → 持久黄条提示补资料 */
const draftCitations = ref<InsightCitation[]>([])
const draftMissing = ref(false)

/** 最近一条客户来信（AI 草稿的依据消息） */
const lastInbound = computed(() => {
  const messages = props.detail?.messages ?? []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].direction === 'in') return messages[i]
  }
  return null
})

/** 最新草稿消息（会话切换/失效后回填编辑态） */
const existingDraft = computed(() => {
  const messages = props.detail?.messages ?? []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].status === 'draft') return messages[i]
  }
  return null
})

/** 会话是否存在等待审核的邮件（composer 折叠为提示态） */
const hasWaitingApproval = computed(() =>
  (props.detail?.messages ?? []).some((m) => m.status === 'waiting_approval'),
)

/** 回复语言 = 最近一条 in 消息 language（06 §7 澄清，无信号默认 en） */
const replyLanguage = computed(() => lastInbound.value?.language ?? 'en')

// 会话切换：草稿态重置为服务端最新（keep-alive 返回保持，切换会话重新对齐）
watch(
  () => props.detail?.conversationId,
  () => {
    draftId.value = existingDraft.value?.messageId ?? null
    draftContent.value = existingDraft.value?.content ?? ''
    draftCitations.value = []
    draftMissing.value = false
  },
  { immediate: true },
)

// 草稿被审批拒绝退回（waiting_approval → draft）：回填最新草稿内容
watch(existingDraft, (message, previous) => {
  if (message && message.messageId !== previous?.messageId && message.messageId !== draftId.value) {
    draftId.value = message.messageId
    draftContent.value = message.content
  }
})

function invalidateConversation(): void {
  void queryClient.invalidateQueries({
    queryKey: qk.conversations.detail(props.detail?.conversationId ?? ''),
  })
  void queryClient.invalidateQueries({ queryKey: qk.conversations.all })
}

// ===== AI 生成 / 重新生成 =====
async function generate(regenerate: boolean): Promise<void> {
  if (!props.detail || !lastInbound.value) return
  generating.value = true
  try {
    const payload = { basedOnMessageId: lastInbound.value.messageId }
    const draft: AiDraft = regenerate
      ? await regenerateAiDraft(props.detail.conversationId, payload)
      : await generateAiDraft(props.detail.conversationId, payload)
    draftId.value = draft.draftId
    draftContent.value = draft.content
    // D9：依据区 citations + grounded=false 持久黄条（02 §5.3）
    draftCitations.value = draft.citations ?? []
    draftMissing.value = Boolean(draft.missingKnowledge)
    ElMessage.success(t('inbox.composer.generated'))
    invalidateConversation()
  } catch (error) {
    handleApiError(error)
  } finally {
    generating.value = false
  }
}

// ===== 保存草稿 =====
const saveMutation = useMutation({
  mutationFn: (input: { messageId: string; content: string }) =>
    updateMessage(input.messageId, { content: input.content }),
  onSuccess: () => {
    ElMessage.success(t('inbox.composer.saved'))
    invalidateConversation()
  },
  onError: (error: ApiError) => handleApiError(error),
})

// ===== 发送（双分支 06 §3.3） =====
const sending = ref(false)

async function onSend(): Promise<void> {
  if (!props.detail || !draftId.value || !draftContent.value.trim()) return
  sending.value = true
  try {
    const result: SendResp = await sendMessage(props.detail.conversationId, {
      messageId: draftId.value,
      content: draftContent.value,
    })
    if (result.status === 'sent') {
      ElMessage.success(t('inbox.composer.sent'))
      draftId.value = null
      draftContent.value = ''
      draftCitations.value = []
      draftMissing.value = false
    } else {
      // 分支 B：审批单已生成（email_send=medium 人工审，Runtime §4.7）→ 全局通知 + 深链审核中心
      notifyWaitingApproval(result.approval.approvalId)
      draftId.value = null
      draftContent.value = ''
      draftCitations.value = []
      draftMissing.value = false
    }
    invalidateConversation()
  } catch (error) {
    handleApiError(error)
  } finally {
    sending.value = false
  }
}

function gotoApprovals(): void {
  void router.push('/approvals')
}

defineExpose({
  /**
   * Copilot「插入草稿」：insert_draft 返回「合并后全文」（服务端已把要点合并进草稿并落库），
   * 因此整体回填而非尾部追加（追加会与已含原草稿的全文重复）；新建草稿时用服务端返回的
   * 真实 draftId 回填，保证后续保存/发送定位到草稿消息而非占位 id。
   */
  insertContent(content: string, serverDraftId?: string): void {
    if (serverDraftId) {
      draftId.value = serverDraftId
    }
    draftContent.value = content
    invalidateConversation()
  },
})
</script>

<template>
  <footer v-if="detail" class="composer" data-testid="draft-composer">
    <!-- 等待审核态：折叠编辑器 -->
    <div v-if="hasWaitingApproval" class="composer__waiting" data-testid="composer-waiting">
      <span>{{ t('inbox.composer.waitingExisting') }}</span>
      <el-button link type="primary" size="small" @click="gotoApprovals">
        {{ t('inbox.gotoApprovals') }}
      </el-button>
    </div>

    <template v-else>
      <div class="composer__toolbar">
        <el-button
          size="small"
          type="primary"
          plain
          :icon="ChatDotRound"
          :loading="generating"
          data-testid="generate-draft"
          @click="generate(false)"
        >
          {{ t('inbox.composer.generateDraft') }}
        </el-button>
        <el-button
          v-if="draftId"
          size="small"
          plain
          :icon="RefreshRight"
          :loading="generating"
          @click="generate(true)"
        >
          {{ t('inbox.composer.regenerate') }}
        </el-button>
        <span class="composer__spacer" />
        <el-tag
          size="small"
          effect="plain"
          type="info"
          :title="t('inbox.composer.replyLanguageTip')"
        >
          {{ t('inbox.composer.replyLanguage') }}: {{ replyLanguage.toUpperCase() }}
        </el-tag>
      </div>

      <template v-if="draftId">
        <!-- D9 依据区：知识中心 citations 溯源（只消费 11 引用，无 08/09 结构化参数） -->
        <div v-if="draftCitations.length" class="composer__citations" data-testid="draft-citations">
          <span class="composer__citations-label">{{ t('inbox.composer.basedOn') }}</span>
          <CitationPopover
            v-for="citation in draftCitations"
            :key="`${citation.docId}:${citation.chunkId ?? ''}`"
            :citation="citation"
          >
            <span class="composer__cite">
              <el-icon><Document /></el-icon>
              {{ citation.docName }}
            </span>
          </CitationPopover>
        </div>
        <!-- D9 grounded=false：持久黄条提示补资料（AI 不编造参数） -->
        <el-alert
          v-if="draftMissing"
          class="composer__missing"
          :title="t('inbox.composer.missingKnowledge')"
          type="warning"
          :closable="false"
          show-icon
          data-testid="draft-missing-knowledge"
        />
        <DraftEditor v-model="draftContent" class="composer__editor" />

        <div class="composer__actions">
          <el-button
            size="small"
            :disabled="saveMutation.isPending.value || !draftContent.trim()"
            :loading="saveMutation.isPending.value"
            @click="saveMutation.mutate({ messageId: draftId, content: draftContent })"
          >
            {{ t('inbox.composer.saveDraft') }}
          </el-button>
          <el-button
            size="small"
            type="primary"
            :icon="Promotion"
            :disabled="!draftContent.trim()"
            :loading="sending"
            data-testid="send-draft"
            @click="onSend"
          >
            {{ t('inbox.composer.send') }}
          </el-button>
        </div>
      </template>

      <div v-else class="composer__hint">{{ t('inbox.composer.noDraftHint') }}</div>
    </template>
  </footer>
</template>

<style scoped lang="scss">
.composer {
  flex-shrink: 0;
  padding: 10px 16px 12px;
  border-top: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color);

  &__toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  &__spacer {
    flex: 1;
  }

  &__editor {
    margin-bottom: 8px;
  }

  &__citations {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 8px;
  }

  &__citations-label {
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }

  &__cite {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    font-size: 12px;
    color: var(--el-color-primary);
    background: var(--el-color-primary-light-9);
    border-radius: 4px;
    cursor: pointer;
  }

  &__missing {
    margin-bottom: 8px;
  }

  &__actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  &__hint {
    padding: 6px 0;
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }

  &__waiting {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    color: var(--el-text-color-regular);
  }
}
</style>
