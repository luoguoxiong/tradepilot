<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'
import { Promotion, Document } from '@element-plus/icons-vue'

import type { ConversationListItem, CopilotData } from '@/api/types/conversations'
import type { Insight } from '@/api/types/insight'
import type { ApiError } from '@/api/http'
import { applySuggestions, askAi, fetchCopilot } from '@/api/resources/conversations'
import CitationPopover from '@/components/business/CitationPopover.vue'
import InsightCard from '@/components/business/InsightCard.vue'
import { qk } from '@/query/keys'

/**
 * AI Copilot Pane（06 §2 右栏 / §1.3）：
 * - 头部：意图 + 采购概率（InsightCard 统一证据链呈现）；
 * - 勾选式建议（FR-06）：内容型 → insert_draft 上抛插入草稿；流程型 → create_tasks 直接执行（D8：P0 不产出 create_quote）；
 * - Ask AI（FR-07）：RAG 检索问答 + citations 溯源。
 */
const props = defineProps<{
  conversationId: string | null
  /** 列表行（Ask AI 上下文提示用） */
  conversation: ConversationListItem | null
}>()

const emit = defineEmits<{
  /** 内容型建议执行：合并要点全文插入草稿编辑器 */
  insertDraft: [content: string]
}>()

const { t } = useI18n()

// ===== Copilot 数据 =====
const copilotQuery = useQuery({
  queryKey: computed(() => qk.conversations.copilot(props.conversationId ?? '')),
  queryFn: () => fetchCopilot(props.conversationId ?? ''),
  enabled: computed(() => !!props.conversationId),
})

const copilot = computed(() => copilotQuery.data.value ?? null)

const probabilityInsight = computed<Insight<number> | null>(() => {
  if (!copilot.value) return null
  return {
    value: copilot.value.purchaseProbability,
    confidence: copilot.value.insight.confidence,
    reasons: copilot.value.insight.reasons,
    citations: copilot.value.citations,
  }
})

// ===== 勾选建议 =====
const checkedIds = ref<Set<string>>(new Set())
const applying = ref(false)

function toggle(suggestionId: string): void {
  const next = new Set(checkedIds.value)
  if (next.has(suggestionId)) next.delete(suggestionId)
  else next.add(suggestionId)
  checkedIds.value = next
}

async function applyChecked(mode: 'insert_draft' | 'create_tasks'): Promise<void> {
  if (!props.conversationId || checkedIds.value.size === 0) return
  applying.value = true
  try {
    const result = await applySuggestions({
      conversationId: props.conversationId,
      suggestionIds: [...checkedIds.value],
      mode,
    })
    if (mode === 'insert_draft' && result.draftContent) {
      emit('insertDraft', result.draftContent)
      ElMessage.success(t('inbox.copilot.inserted'))
    } else if (mode === 'create_tasks') {
      ElMessage.success(t('inbox.copilot.tasksCreated', { count: result.taskIds?.length ?? 0 }))
    }
    checkedIds.value = new Set()
  } catch (error) {
    ElMessage.error((error as ApiError).message || t('common.operationFailed'))
  } finally {
    applying.value = false
  }
}

const checkedContent = computed(
  () => copilot.value?.suggestions.filter((s) => s.kind === 'content' && checkedIds.value.has(s.suggestionId)).length ?? 0,
)
const checkedProcess = computed(
  () => copilot.value?.suggestions.filter((s) => s.kind === 'process' && checkedIds.value.has(s.suggestionId)).length ?? 0,
)

// ===== Ask AI =====
const question = ref('')
const asking = ref(false)
const answer = ref<{ answer: string; citations: CopilotData['citations'] } | null>(null)

async function ask(): Promise<void> {
  if (!props.conversationId || !question.value.trim()) return
  asking.value = true
  answer.value = null
  try {
    answer.value = await askAi(props.conversationId, { question: question.value.trim() })
  } catch (error) {
    ElMessage.error((error as ApiError).message || t('common.operationFailed'))
  } finally {
    asking.value = false
  }
}
</script>

<template>
  <aside class="copilot" data-testid="copilot-pane">
    <header class="copilot__head">
      <h3 class="copilot__title">{{ t('inbox.copilot.title') }}</h3>
      <el-tag v-if="copilot" size="small" effect="plain" type="primary">
        {{ t(`inbox.intent.${copilot.intent}`) }}
      </el-tag>
    </header>

    <div v-loading="copilotQuery.isLoading.value" class="copilot__scroll">
      <!-- 采购概率 + 证据链（InsightCard 统一呈现） -->
      <div v-if="probabilityInsight" class="copilot__section">
        <InsightCard
          :insight="probabilityInsight"
          :value-label="t('inbox.copilot.probabilityLabel')"
        />
      </div>

      <!-- 勾选式建议（FR-06） -->
      <section v-if="copilot?.suggestions.length" class="copilot__section" data-testid="copilot-suggestions">
        <h4 class="copilot__section-title">{{ t('inbox.copilot.suggestions') }}</h4>
        <el-checkbox-group :model-value="[...checkedIds]" class="copilot__suggestion-group">
          <el-checkbox
            v-for="s in copilot.suggestions"
            :key="s.suggestionId"
            :value="s.suggestionId"
            class="copilot__suggestion"
            @change="toggle(s.suggestionId)"
          >
            <span class="copilot__suggestion-label">
              <el-tag v-if="s.kind === 'process'" size="small" type="warning" effect="plain">
                {{ t('inbox.copilot.kindProcess') }}
              </el-tag>
              {{ s.label }}
            </span>
          </el-checkbox>
        </el-checkbox-group>
        <div class="copilot__suggestion-actions">
          <el-button
            size="small"
            type="primary"
            plain
            :disabled="checkedContent === 0 || applying"
            :loading="applying && checkedContent > 0"
            @click="applyChecked('insert_draft')"
          >
            {{ t('inbox.copilot.insertDraft') }}
          </el-button>
          <el-button
            size="small"
            plain
            :disabled="checkedProcess === 0 || applying"
            :loading="applying && checkedProcess > 0"
            @click="applyChecked('create_tasks')"
          >
            {{ t('inbox.copilot.createTasks') }}
          </el-button>
        </div>
      </section>

      <!-- Ask AI（FR-07 RAG 检索） -->
      <section class="copilot__section" data-testid="ask-ai">
        <h4 class="copilot__section-title">{{ t('inbox.copilot.askAi') }}</h4>
        <el-input
          v-model="question"
          type="textarea"
          :rows="2"
          :placeholder="t('inbox.copilot.askPlaceholder')"
          maxlength="500"
          show-word-limit
        />
        <el-button
          class="copilot__ask-btn"
          type="primary"
          size="small"
          :icon="Promotion"
          :loading="asking"
          :disabled="!question.trim()"
          @click="ask"
        >
          {{ t('inbox.copilot.ask') }}
        </el-button>

        <div v-if="answer" class="copilot__answer" data-testid="ask-ai-answer">
          <p class="copilot__answer-text">{{ answer.answer }}</p>
          <div v-if="answer.citations.length" class="copilot__answer-citations">
            <CitationPopover
              v-for="citation in answer.citations"
              :key="`${citation.docId}:${citation.chunkId ?? ''}`"
              :citation="citation"
            >
              <span class="copilot__cite">
                <el-icon><Document /></el-icon>
                {{ citation.docName }}
              </span>
            </CitationPopover>
          </div>
        </div>
      </section>

      <el-empty
        v-if="!copilotQuery.isLoading.value && !copilot"
        :description="t('inbox.selectConversation')"
        :image-size="64"
      />
    </div>
  </aside>
</template>

<style scoped lang="scss">
.copilot {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  border-left: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color);

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px 8px;
    border-bottom: 1px solid var(--el-border-color-lighter);
  }

  &__title {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }

  &__scroll {
    flex: 1;
    min-height: 0;
    padding: 12px 14px;
    overflow-y: auto;
  }

  &__section {
    margin-bottom: 18px;
  }

  &__section-title {
    margin: 0 0 8px;
    font-size: 13px;
    font-weight: 600;
    color: var(--el-text-color-regular);
  }

  &__suggestion-group {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  &__suggestion {
    height: auto;
    margin-right: 0;
    align-items: flex-start;

    :deep(.el-checkbox__label) {
      white-space: normal;
      line-height: 1.5;
    }
  }

  &__suggestion-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }

  &__suggestion-actions {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }

  &__ask-btn {
    margin-top: 8px;
  }

  &__answer {
    margin-top: 10px;
    padding: 10px 12px;
    border: 1px solid var(--el-color-primary-light-7);
    border-radius: 6px;
    background: var(--el-color-primary-light-9);
  }

  &__answer-text {
    margin: 0 0 8px;
    font-size: 13px;
    line-height: 1.7;
    white-space: pre-wrap;
  }

  &__answer-citations {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  &__cite {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--el-fill-color);
    font-size: 12px;
    color: var(--el-color-primary);
    cursor: pointer;
  }
}
</style>
