<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import InsightCard from '@/components/business/InsightCard.vue'
import { fetchQuoteAiPricing } from '@/api/resources/quotes'
import { handleApiError } from '@/api/error-handler'
import type { Insight } from '@/api/types/insight'
import type { QuoteAiPricingResp, QuoteCostItemKey } from '@/api/types/quotes'

/**
 * AI 定价建议面板（09 §3.2 / FR-03）：
 * 只读展示结构化定价引擎的建议单价 / 利润率 / 成本构成 + 原因链（InsightCard）。
 * 成本、红线、建议价均由服务端 core 定价引擎计算，前端不参与算术；
 * confidence 取 1（确定性核算而非模型估计），故不出现低置信角标。
 */
const props = withDefaults(
  defineProps<{
    quoteId: string
    currency: string
    /** 进入即拉取（draft 态定价建议是决策主诉求，09 §1.2 FR-03） */
    auto?: boolean
  }>(),
  { auto: false },
)

const { t } = useI18n()

const loading = ref(false)
const result = ref<QuoteAiPricingResp | null>(null)

const COST_ITEMS: { key: QuoteCostItemKey; labelKey: string }[] = [
  { key: 'purchase', labelKey: 'quotes.costPurchase' },
  { key: 'freight', labelKey: 'quotes.costFreight' },
  { key: 'insurance', labelKey: 'quotes.costInsurance' },
  { key: 'tax', labelKey: 'quotes.costTax' },
  { key: 'fx', labelKey: 'quotes.costFx' },
]

/** 定价引擎为确定性核算：value=建议单价、confidence=1、reasons=原因链 */
const insight = computed<Insight<number> | null>(() => {
  if (!result.value) return null
  return {
    value: Number(result.value.suggestedUnitPrice),
    confidence: 1,
    reasons: result.value.reasons ?? [],
    generatedAt: new Date().toISOString(),
  }
})

async function load() {
  loading.value = true
  try {
    result.value = await fetchQuoteAiPricing(props.quoteId)
  } catch (error) {
    handleApiError(error, { fallback: t('quotes.aiPricingFailed') })
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (props.auto) void load()
})
</script>

<template>
  <div class="pricing-panel">
    <div class="pricing-panel__head">
      <div>
        <span class="pricing-panel__title">{{ t('quotes.aiPricingTitle') }}</span>
        <span class="pricing-panel__desc">{{ t('quotes.aiPricingDesc') }}</span>
      </div>
      <el-button size="small" :loading="loading" @click="load">
        {{ t('quotes.getAiPricing') }}
      </el-button>
    </div>

    <template v-if="result">
      <InsightCard
        :insight="insight"
        :value-label="t('quotes.suggestedUnitPrice')"
        :value-suffix="props.currency"
      />

      <div class="pricing-panel__margin">
        <span class="pricing-panel__margin-label">{{ t('quotes.profitMargin') }}</span>
        <strong>{{ result.profitMarginPct }}%</strong>
      </div>

      <div class="pricing-panel__section">{{ t('quotes.costsTitle') }}</div>
      <el-descriptions :column="2" size="small" border>
        <el-descriptions-item v-for="item in COST_ITEMS" :key="item.key" :label="t(item.labelKey)">
          {{ result.costBreakdown[item.key] }}
        </el-descriptions-item>
      </el-descriptions>
    </template>

    <p v-else-if="!loading" class="pricing-panel__empty">{{ t('quotes.aiPricingEmpty') }}</p>
  </div>
</template>

<style scoped lang="scss">
.pricing-panel {
  &__head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }

  &__title {
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__desc {
    display: block;
    margin-top: 2px;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__margin {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 10px 0;
    font-size: 13px;

    strong {
      font-size: 16px;
      font-weight: 700;
    }
  }

  &__margin-label {
    color: var(--tp-text-secondary);
  }

  &__section {
    margin: 10px 0 6px;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__empty {
    margin: 0;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }
}
</style>
