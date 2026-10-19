<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useQueryClient } from '@tanstack/vue-query'
import { ArrowLeft, Download, Edit, Link } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import EmptyState from '@/components/business/EmptyState.vue'
import QuoteFormDialog from '../components/QuoteFormDialog.vue'
import QuotePricingPanel from '../components/QuotePricingPanel.vue'
import { useQuoteDetail, useQuoteNegotiationLadder } from '../composables/useQuotes'
import {
  downloadQuotePdf,
  markQuoteLost,
  markQuoteWon,
  reviveQuote,
  sendQuote,
  submitQuote,
} from '@/api/resources/quotes'
import { handleApiError } from '@/api/error-handler'
import { useDictStore } from '@/stores/dict'
import { qk } from '@/query/keys'
import type { QuoteCostItemKey } from '@/api/types/quotes'

/**
 * 09 报价详情（09 §1.2/§1.3 + §3 状态流转，FR-01~FR-05）：
 * 报价头/明细/成本/关联审批只读展示 + 状态机动作（提交审核 → 发送 → 成交/失效 → 复活）；
 * 所有流转按服务端返回状态刷新（40901 非法流转由 error-handler 提示，乐观更新不适用）；
 * AI 定价建议与议价梯度为只读辅助，绝不在前端做定价算术。
 */
defineOptions({ name: 'QuoteDetailView' })

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()
const dict = useDictStore()

const quoteId = computed(() => String(route.params.id ?? ''))
const { data: quote, isLoading } = useQuoteDetail(quoteId)

const busy = ref(false)
const editVisible = ref(false)
const lostVisible = ref(false)
const lostReason = ref('')

/** 议价梯度：16 未配置 discountLadder → 空数组 → 隐藏区块（09 决策 A2） */
const { data: ladder } = useQuoteNegotiationLadder(quoteId)
const showLadder = computed(() => (ladder.value?.ladder.length ?? 0) > 0)

const COST_ITEMS: { key: QuoteCostItemKey; labelKey: string }[] = [
  { key: 'purchase', labelKey: 'quotes.costPurchase' },
  { key: 'freight', labelKey: 'quotes.costFreight' },
  { key: 'insurance', labelKey: 'quotes.costInsurance' },
  { key: 'tax', labelKey: 'quotes.costTax' },
  { key: 'fx', labelKey: 'quotes.costFx' },
]

const LOST_REASONS = ['price', 'no_response', 'competitor', 'timing', 'other'] as const

const isDraft = computed(() => quote.value?.status === 'draft')
const isLost = computed(() => quote.value?.status === 'lost')
const isSent = computed(() => quote.value?.status === 'sent')
const isWaitingApproval = computed(() => quote.value?.status === 'waiting_approval')

/** 发送前置：关联审批须为通过态（09 §3.4） */
const approvalPassed = computed(() =>
  ['approved', 'edited_approved', 'auto_approved'].includes(quote.value?.approval?.status ?? ''),
)

function statusLabel(): string {
  return dict.label('quoteStatus', quote.value?.status ?? '')
}

function statusColor(): string {
  return dict.color('quoteStatus', quote.value?.status ?? '') ?? 'var(--ai-idle)'
}

function formatDateTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : '—'
}

async function refresh() {
  await queryClient.invalidateQueries({ queryKey: qk.quotes.all })
}

/** 状态流转统一入口：确认 → 调用 → 提示 → 失效列表/详情/Tab 计数 */
async function runAction(
  confirmText: string,
  request: () => Promise<{ message: string } | void>,
  successKey: string,
) {
  try {
    await ElMessageBox.confirm(confirmText, t('common.confirm'), {
      type: 'warning',
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
    })
  } catch {
    return
  }

  busy.value = true
  try {
    const result = await request()
    const extra = result && 'message' in result ? result.message : ''
    ElMessage.success(extra || t(successKey))
    await refresh()
  } catch (error) {
    handleApiError(error)
  } finally {
    busy.value = false
  }
}

function onSubmit() {
  return runAction(
    t('quotes.submitConfirm'),
    async () => {
      await submitQuote(quoteId.value)
    },
    'quotes.submitSuccess',
  )
}

function onSend() {
  return runAction(
    t('quotes.sendConfirm'),
    async () => {
      await sendQuote(quoteId.value)
    },
    'quotes.sendSuccess',
  )
}

function onMarkWon() {
  return runAction(
    t('quotes.markWonConfirm'),
    async () => {
      const resp = await markQuoteWon(quoteId.value)
      return { message: resp.customerUpgraded ? t('quotes.markWonUpgraded') : '' }
    },
    'quotes.markWonSuccess',
  )
}

function onRevive() {
  return runAction(
    t('quotes.reviveConfirm'),
    async () => {
      await reviveQuote(quoteId.value)
    },
    'quotes.reviveSuccess',
  )
}

function openLost() {
  lostReason.value = ''
  lostVisible.value = true
}

async function confirmLost() {
  busy.value = true
  try {
    const payload = lostReason.value ? { reason: lostReason.value } : {}
    await markQuoteLost(quoteId.value, payload)
    ElMessage.success(t('quotes.markLostSuccess'))
    lostVisible.value = false
    await refresh()
  } catch (error) {
    handleApiError(error)
  } finally {
    busy.value = false
  }
}

async function onExportPdf() {
  if (!quote.value) return
  busy.value = true
  try {
    await downloadQuotePdf(quoteId.value, `${quote.value.quoteNo}.pdf`)
    ElMessage.success(t('quotes.exportSuccess'))
  } catch (error) {
    handleApiError(error)
  } finally {
    busy.value = false
  }
}

function gotoApproval() {
  const approvalId = quote.value?.approval?.approvalId
  if (!approvalId) return
  void router.push({ name: 'approvals', query: { approvalId } })
}

function back() {
  void router.push({ name: 'quotes' })
}
</script>

<template>
  <div v-loading="isLoading" class="quote-detail">
    <template v-if="quote">
      <div class="quote-detail__header">
        <div class="quote-detail__head-left">
          <el-button link :icon="ArrowLeft" @click="back">{{ t('common.back') }}</el-button>
          <h3 class="quote-detail__no">{{ quote.quoteNo }}</h3>
          <span class="quote-detail__status" :style="{ color: statusColor() }">
            {{ statusLabel() }}
          </span>
          <span class="quote-detail__amount">{{ quote.currency }} {{ quote.totalAmount }}</span>
        </div>
        <div class="quote-detail__actions">
          <el-button v-if="isDraft" :icon="Edit" @click="editVisible = true">
            {{ t('common.edit') }}
          </el-button>
          <el-button v-if="isDraft" type="primary" :loading="busy" @click="onSubmit">
            {{ t('quotes.submit') }}
          </el-button>
          <el-tooltip
            v-if="isWaitingApproval"
            :content="approvalPassed ? '' : t('quotes.sendRequiresApproval')"
            :disabled="approvalPassed"
          >
            <span>
              <el-button type="primary" :disabled="!approvalPassed" :loading="busy" @click="onSend">
                {{ t('quotes.send') }}
              </el-button>
            </span>
          </el-tooltip>
          <el-button v-if="isSent" type="success" :loading="busy" @click="onMarkWon">
            {{ t('quotes.markWon') }}
          </el-button>
          <el-button v-if="!isLost && quote.status !== 'won'" :loading="busy" @click="openLost">
            {{ t('quotes.markLost') }}
          </el-button>
          <el-button v-if="isLost" type="primary" :loading="busy" @click="onRevive">
            {{ t('quotes.revive') }}
          </el-button>
          <el-button :icon="Download" :loading="busy" @click="onExportPdf">
            {{ t('quotes.exportPdf') }}
          </el-button>
        </div>
      </div>

      <!-- 报价信息（09 §1.2） -->
      <div class="quote-detail__section">
        <div class="quote-detail__section-title">{{ t('quotes.basicInfo') }}</div>
        <el-descriptions :column="3" border size="small">
          <el-descriptions-item :label="t('quotes.customer')">
            {{ quote.customerName }}
            <el-tag
              v-if="quote.customer"
              size="small"
              :type="quote.customer.isFormal ? 'success' : 'info'"
            >
              {{
                quote.customer.isFormal ? t('quotes.customerFormal') : t('quotes.customerPotential')
              }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item :label="t('quotes.contact')">
            {{ quote.contact?.name ?? '—' }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('quotes.currency')">
            {{ quote.currency }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('quotes.incoterms')">
            {{ quote.incoterms || '—' }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('quotes.validUntil')">
            {{ quote.validUntil }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('quotes.paymentTerms')">
            {{ quote.paymentTerms || '—' }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('quotes.exchangeRate')">
            {{ quote.exchangeRate.rate }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('quotes.exchangeRateSource')">
            {{ quote.exchangeRate.source }} · {{ quote.exchangeRate.date }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('quotes.createdAt')">
            {{ formatDateTime(quote.createdAt) }}
          </el-descriptions-item>
          <el-descriptions-item v-if="quote.sentAt" :label="t('quotes.sentAt')">
            {{ formatDateTime(quote.sentAt) }}
          </el-descriptions-item>
          <el-descriptions-item v-if="quote.wonAt" :label="t('quotes.wonAt')">
            {{ formatDateTime(quote.wonAt) }}
          </el-descriptions-item>
          <el-descriptions-item v-if="quote.lostReason" :label="t('quotes.lostReason')">
            {{ dict.label('quoteLostReason', quote.lostReason) }}
          </el-descriptions-item>
        </el-descriptions>
      </div>

      <!-- 明细行（09 §1.3） -->
      <div class="quote-detail__section">
        <div class="quote-detail__section-title">{{ t('quotes.itemsTitle') }}</div>
        <el-table :data="quote.items" size="small" border>
          <el-table-column prop="productName" :label="t('quotes.product')" min-width="220" />
          <el-table-column prop="quantity" :label="t('quotes.quantity')" width="120" />
          <el-table-column prop="unitPrice" :label="t('quotes.unitPrice')" width="140" />
          <el-table-column prop="lineTotal" :label="t('quotes.lineTotal')" width="160" />
        </el-table>
      </div>

      <!-- 成本构成 + 利润率（09 §1.3；定价引擎核算，前端只读） -->
      <div class="quote-detail__section">
        <div class="quote-detail__section-title">{{ t('quotes.costsTitle') }}</div>
        <el-descriptions :column="3" border size="small">
          <el-descriptions-item
            v-for="item in COST_ITEMS"
            :key="item.key"
            :label="t(item.labelKey)"
          >
            {{ quote.costBreakdown[item.key] }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('quotes.profitMargin')">
            {{ quote.profitMarginPct === null ? '—' : `${quote.profitMarginPct}%` }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('quotes.totalAmount')">
            <strong>{{ quote.currency }} {{ quote.totalAmount }}</strong>
          </el-descriptions-item>
        </el-descriptions>
      </div>

      <div class="quote-detail__grid">
        <!-- AI 定价建议（09 §3.2；draft 态进入即拉取，原因链必展示） -->
        <div class="quote-detail__card">
          <QuotePricingPanel :quote-id="quoteId" :currency="quote.currency" :auto="isDraft" />
        </div>

        <!-- 议价梯度（09 §3.8，只读建议；16 未配置则整块隐藏，绝不返回底价） -->
        <div v-if="showLadder" class="quote-detail__card">
          <div class="quote-detail__section-title">{{ t('quotes.negotiationTitle') }}</div>
          <el-table :data="ladder?.ladder ?? []" size="small">
            <el-table-column prop="round" :label="t('quotes.negotiationRound')" width="90" />
            <el-table-column
              prop="discountPct"
              :label="t('quotes.negotiationDiscount')"
              width="120"
            />
            <el-table-column prop="suggestedUnitPrice" :label="t('quotes.negotiationPrice')" />
          </el-table>
        </div>
      </div>

      <!-- 关联审批（09 §3.3） -->
      <div v-if="quote.approval" class="quote-detail__section">
        <div class="quote-detail__section-title">{{ t('quotes.approvalTitle') }}</div>
        <div class="quote-detail__approval">
          <span>
            {{ dict.label('approvalStatus', quote.approval.status) }}
          </span>
          <el-tag size="small" :type="quote.approval.riskLevel === 'high' ? 'danger' : 'warning'">
            {{ t(`approvals.risk.${quote.approval.riskLevel}`) }}
          </el-tag>
          <span class="quote-detail__approval-id">{{ quote.approval.approvalId }}</span>
          <el-button link type="primary" :icon="Link" @click="gotoApproval">
            {{ t('quotes.approvalTitle') }}
          </el-button>
        </div>
      </div>
    </template>

    <EmptyState v-else-if="!isLoading" />

    <!-- 编辑（仅草稿，09 §3.1） -->
    <QuoteFormDialog v-model="editVisible" mode="edit" :quote="quote ?? null" @saved="refresh" />

    <!-- 标记失效（原因选填，09 §3.7） -->
    <el-dialog v-model="lostVisible" :title="t('quotes.markLostTitle')" width="420px">
      <el-select v-model="lostReason" clearable style="width: 100%">
        <el-option
          v-for="reason in LOST_REASONS"
          :key="reason"
          :value="reason"
          :label="dict.label('quoteLostReason', reason)"
        />
      </el-select>
      <template #footer>
        <el-button @click="lostVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="busy" @click="confirmLost">
          {{ t('common.confirm') }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped lang="scss">
.quote-detail {
  display: flex;
  flex-direction: column;
  gap: calc(var(--tp-spacing-base) * 2);

  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }

  &__head-left {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  &__no {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
  }

  &__status {
    font-weight: 600;
  }

  &__amount {
    font-size: 16px;
    font-weight: 700;
    color: var(--tp-text-primary);
  }

  &__actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  &__section-title {
    margin-bottom: 8px;
    font-size: 14px;
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
    gap: calc(var(--tp-spacing-base) * 2);
  }

  &__card {
    padding: calc(var(--tp-spacing-base) * 1.5);
    border: 1px solid var(--tp-border-color);
    border-radius: var(--tp-radius-base, 8px);
  }

  &__approval {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  &__approval-id {
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }
}
</style>
