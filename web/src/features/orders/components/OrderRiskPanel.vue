<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useQueryClient } from '@tanstack/vue-query'
import { ElMessage, ElMessageBox } from 'element-plus'

import InsightCard from '@/components/business/InsightCard.vue'
import { draftOrderDelayEmail, executeOrderRisk, fetchOrderRisk } from '@/api/resources/orders'
import { handleApiError } from '@/api/error-handler'
import { useDictStore } from '@/stores/dict'
import { qk } from '@/query/keys'
import type { OrderRiskView } from '@/api/types/orders'
import type { Insight } from '@/api/types/insight'

/**
 * 履约风险面板（10 §3.4/§3.5/§3.7，FR-04~FR-07）：
 * - 展示规则引擎判定（原因 / 证据 / 建议），「重新评估」走实时接口覆盖展示；
 * - 建议执行：internal → 建内部跟进任务，customer → 生成延期沟通草稿 + message_send 审批；
 * - 规则引擎为确定性判定（confidence=null），仅在 AI 洞察覆盖文案时呈现置信度（04 §2.1）。
 */
const props = defineProps<{
  orderId: string
  insight: OrderRiskView | null
}>()

const { t } = useI18n()
const router = useRouter()
const queryClient = useQueryClient()
const dict = useDictStore()

const evaluating = ref(false)
const executing = ref(false)
const evaluated = ref<OrderRiskView | null>(null)
const selectedIds = ref<string[]>([])

const draftVisible = ref(false)
const draftContent = ref('')
const draftConversationId = ref('')

/** 展示口径：实时评估结果优先，其次详情内落库洞察 */
const view = computed<OrderRiskView | null>(() => evaluated.value ?? props.insight)

const suggestions = computed(() => view.value?.suggestions ?? [])

const isAtRisk = computed(() => view.value?.risk === 'at_risk')

/** AI 洞察覆盖文案时才有置信度；规则引擎不呈现置信度（04 §2.1 仅约束 AI 结论） */
const insightCard = computed<Insight<number> | null>(() => {
  const current = view.value
  if (!current || current.confidence === null) return null
  return {
    value: current.delayDays,
    confidence: current.confidence,
    reasons: [{ text: current.reason }],
    generatedAt: current.generatedAt,
  }
})

function riskLabel(): string {
  return view.value ? dict.label('orderRisk', view.value.risk) : ''
}

function riskColor(): string {
  return (view.value && dict.color('orderRisk', view.value.risk)) || 'var(--ai-idle)'
}

function sourceLabel(): string {
  return view.value?.source === 'ai_insight' ? t('orders.riskSourceAi') : t('orders.riskSourceRule')
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString()
}

/** 10 §3.4 重新评估：规则引擎实时判定（不依赖 AI 产出，AI 洞察存在时覆盖文案） */
async function evaluate() {
  evaluating.value = true
  try {
    const result = await fetchOrderRisk(props.orderId)
    evaluated.value = result
    selectedIds.value = []
  } catch (error) {
    handleApiError(error)
  } finally {
    evaluating.value = false
  }
}

/** 10 §3.5 执行所选建议：内部建任务、客户走草稿 + 审批 */
async function execute() {
  if (selectedIds.value.length === 0) return
  try {
    await ElMessageBox.confirm(t('orders.executeConfirm'), t('common.confirm'), {
      type: 'warning',
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
    })
  } catch {
    return
  }

  executing.value = true
  try {
    const resp = await executeOrderRisk(props.orderId, { suggestionIds: selectedIds.value })
    ElMessage.success(
      t('orders.executeSuccess', {
        tasks: resp.taskIds.length,
        approvals: resp.approvalIds.length,
      }),
    )
    if (resp.draft) {
      draftContent.value = resp.draft.content
      draftConversationId.value = resp.draft.conversationId
      draftVisible.value = true
    }
    selectedIds.value = []
    await queryClient.invalidateQueries({ queryKey: qk.orders.all })
  } catch (error) {
    handleApiError(error)
  } finally {
    executing.value = false
  }
}

/** 10 §3.7 直接生成延期沟通草稿（人工确认后发送，不自动外发） */
async function generateDraft() {
  executing.value = true
  try {
    const resp = await draftOrderDelayEmail(props.orderId)
    draftContent.value = resp.content
    draftConversationId.value = resp.conversationId
    draftVisible.value = true
    ElMessage.success(t('orders.draftEmailSuccess'))
    await queryClient.invalidateQueries({ queryKey: qk.orders.all })
  } catch (error) {
    handleApiError(error)
  } finally {
    executing.value = false
  }
}

function gotoInbox() {
  draftVisible.value = false
  void router.push({ name: 'inbox', query: { conversationId: draftConversationId.value } })
}
</script>

<template>
  <div class="order-risk">
    <div class="order-risk__head">
      <span class="order-risk__title">{{ t('orders.riskTitle') }}</span>
      <el-button size="small" :loading="evaluating" @click="evaluate">
        {{ t('orders.evaluateRisk') }}
      </el-button>
    </div>

    <template v-if="view">
      <div class="order-risk__badge">
        <span class="order-risk__dot" :style="{ background: riskColor() }" />
        <span class="order-risk__level" :style="{ color: riskColor() }">{{ riskLabel() }}</span>
        <el-tag v-if="isAtRisk" size="small" type="danger">
          {{ t('orders.riskDelayDays', { days: view.delayDays }) }}
        </el-tag>
        <span class="order-risk__meta">
          {{ t('orders.riskSource') }}：{{ sourceLabel() }} · {{ t('orders.riskGeneratedAt') }}
          {{ formatDateTime(view.generatedAt) }}
        </span>
      </div>

      <div class="order-risk__section">{{ t('orders.riskReason') }}</div>
      <p class="order-risk__reason">{{ view.reason }}</p>

      <!-- AI 洞察覆盖文案时呈现置信度（规则引擎 confidence=null，不做概率表达） -->
      <InsightCard v-if="insightCard" :insight="insightCard" />

      <div class="order-risk__section">{{ t('orders.riskEvidence') }}</div>
      <el-descriptions :column="2" size="small" border>
        <el-descriptions-item :label="t('orders.riskPlannedPct')">
          {{ view.evidence.plannedPct ?? '—' }}%
        </el-descriptions-item>
        <el-descriptions-item :label="t('orders.riskActualPct')">
          {{ view.evidence.actualPct ?? '—' }}%
        </el-descriptions-item>
      </el-descriptions>

      <!-- 风险建议（10 §3.5：internal 建任务 / customer 草稿 + 审批） -->
      <template v-if="suggestions.length">
        <div class="order-risk__section">{{ t('orders.suggestionsTitle') }}</div>
        <el-checkbox-group v-model="selectedIds" class="order-risk__suggestions">
          <el-checkbox
            v-for="item in suggestions"
            :key="item.suggestionId"
            :value="item.suggestionId"
          >
            <span>{{ item.label }}</span>
            <el-tag size="small" :type="item.type === 'customer' ? 'warning' : 'info'">
              {{
                item.type === 'customer'
                  ? t('orders.suggestionCustomer')
                  : t('orders.suggestionInternal')
              }}
            </el-tag>
          </el-checkbox>
        </el-checkbox-group>
        <div class="order-risk__actions">
          <el-button
            type="primary"
            :disabled="selectedIds.length === 0"
            :loading="executing"
            @click="execute"
          >
            {{ t('orders.executeSelected') }}
          </el-button>
          <el-button :loading="executing" @click="generateDraft">
            {{ t('orders.draftEmail') }}
          </el-button>
        </div>
      </template>
      <p v-else class="order-risk__empty">{{ t('orders.emptyRisk') }}</p>
    </template>

    <p v-else class="order-risk__empty">{{ t('orders.riskEmpty') }}</p>

    <!-- 延期沟通草稿（10 §3.7：仅生成草稿 + 审批，绝不自动外发） -->
    <el-dialog v-model="draftVisible" :title="t('orders.draftEmail')" width="620px" append-to-body>
      <el-input v-model="draftContent" type="textarea" :rows="10" readonly />
      <template #footer>
        <el-button @click="draftVisible = false">{{ t('common.close') }}</el-button>
        <el-button type="primary" @click="gotoInbox">{{ t('orders.viewConversation') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped lang="scss">
.order-risk {
  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }

  &__title {
    font-size: 14px;
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__badge {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }

  &__dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  &__level {
    font-weight: 600;
  }

  &__meta {
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__section {
    margin: 12px 0 6px;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__reason {
    margin: 0;
    line-height: 1.6;
    color: var(--tp-text-primary);
  }

  &__suggestions {
    display: flex;
    flex-direction: column;
    gap: 6px;

    :deep(.el-checkbox) {
      height: auto;
      margin-right: 0;
    }

    :deep(.el-checkbox__label) {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      white-space: normal;
    }
  }

  &__actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }

  &__empty {
    margin: 0;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }
}
</style>
