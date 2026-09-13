<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'

import AiStatusTag from '@/components/business/AiStatusTag.vue'
import EmptyState from '@/components/business/EmptyState.vue'
import MoneyText from '@/components/business/MoneyText.vue'
import { getQuotes } from '@/api/resources/quotes'
import type { QuoteListItem, QuoteListResp } from '@/api/types/quotes'
import { qk } from '@/query/keys'
import { listQueryOptions } from '@/query/options'
import { DEFAULT_TIMEZONE, formatInOrgTz } from '@/utils/date'

/**
 * QuotesPanel Quotes 页签（04 §1.4 / FR-07，D6）：
 * 数据源 = 09 报价列表接口的客户维度过滤（`customerId`），不另建存储；
 * 行点击跳 09 报价详情；空态提供「去 09 创建报价」引导（带客户深链）。
 */
const props = withDefaults(defineProps<{ entityId: string; timezone?: string }>(), {
  timezone: DEFAULT_TIMEZONE,
})

const { t } = useI18n()
const router = useRouter()

const page = ref(1)
const pageSize = 10

const filters = computed(() => ({ customerId: props.entityId, page: page.value, pageSize }))

const quotesQuery = useQuery<QuoteListResp>({
  queryKey: computed(() => qk.quotes.list(filters.value)),
  queryFn: () => getQuotes(filters.value),
  ...listQueryOptions(),
})

watch(
  () => props.entityId,
  () => {
    page.value = 1
  },
)

const list = computed<QuoteListItem[]>(() => quotesQuery.data.value?.items ?? [])
const total = computed(() => quotesQuery.data.value?.total ?? 0)

function openQuote(row: QuoteListItem) {
  void router.push({ name: 'quote-detail', params: { id: row.quoteId } })
}

function dateText(value: string): string {
  return formatInOrgTz(value, props.timezone, 'YYYY-MM-DD')
}

/** 空态引导：跳 09 并直接打开新建弹窗（客户预置） */
function createQuote() {
  void router.push({ name: 'quotes', query: { customerId: props.entityId, create: '1' } })
}
</script>

<template>
  <div class="quotes-panel">
    <el-skeleton v-if="quotesQuery.isLoading.value" :rows="4" animated />

    <template v-else>
      <div v-if="list.length" class="quotes-panel__list">
        <div
          v-for="row in list"
          :key="row.quoteId"
          class="quotes-panel__item"
          role="button"
          @click="openQuote(row)"
        >
          <div class="quotes-panel__main">
            <span class="quotes-panel__no">{{ row.quoteNo }}</span>
            <AiStatusTag group="quoteStatus" :value="row.status" />
          </div>
          <div class="quotes-panel__meta">
            <MoneyText
              class="quotes-panel__amount"
              :amount="row.totalAmount"
              :currency="row.currency"
            />
            <span class="quotes-panel__date">{{ dateText(row.createdAt) }}</span>
          </div>
        </div>
      </div>

      <EmptyState
        v-else
        class="quotes-panel__empty"
        :title="t('c360.quotesEmpty')"
        :description="t('c360.quotesEmptyHint')"
      >
        <el-button type="primary" @click="createQuote">{{ t('c360.createQuote') }}</el-button>
      </EmptyState>

      <el-pagination
        v-if="total > pageSize"
        class="quotes-panel__pager"
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
.quotes-panel {
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
    cursor: pointer;

    &:last-child {
      border-bottom: none;
    }

    &:hover {
      background: color-mix(in srgb, var(--tp-primary) 5%, transparent);
    }
  }

  &__main {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  &__no {
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__meta {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 16px;
  }

  &__amount {
    font-variant-numeric: tabular-nums;
    color: var(--tp-text-primary);
  }

  &__date {
    font-size: 12px;
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
