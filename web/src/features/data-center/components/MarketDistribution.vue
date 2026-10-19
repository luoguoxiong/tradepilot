<script setup lang="ts">
import { useI18n } from 'vue-i18n'

import EmptyState from '@/components/business/EmptyState.vue'
import type { MarketRow } from '@/api/types/analytics'
import { useDictStore } from '@/stores/dict'

/**
 * 市场分布（15 §1.3 饼图/柱图 + §3.2）：占比条形列表，点击国家下钻「新客户」明细
 * （不叠加 country 筛选，下钻时以该国家作为筛选条件，卡片数字与明细 total 可对账）。
 */
const props = withDefaults(defineProps<{ markets: MarketRow[]; loading?: boolean }>(), {
  loading: false,
})

const emit = defineEmits<{ drilldown: [country: string] }>()

const { t } = useI18n()
const dict = useDictStore()

const OTHER = 'OTHER'

function labelOf(country: string): string {
  return country === OTHER ? t('dataCenter.otherMarkets') : dict.label('country', country)
}
</script>

<template>
  <div class="market" v-loading="props.loading">
    <EmptyState v-if="props.markets.length === 0 && !props.loading" />
    <div
      v-for="row in props.markets"
      :key="row.country"
      class="market__row"
      role="button"
      :title="t('dataCenter.drilldownHint')"
      @click="emit('drilldown', row.country)"
    >
      <span class="market__name">{{ labelOf(row.country) }}</span>
      <span class="market__bar">
        <i class="market__bar-fill" :style="{ width: `${row.pct}%` }" />
      </span>
      <span class="market__count">{{ row.customerCount }}</span>
      <span class="market__pct">{{ row.pct }}%</span>
    </div>
  </div>
</template>

<style scoped lang="scss">
.market {
  &__row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0;
    cursor: pointer;

    &:hover .market__name {
      color: var(--el-color-primary);
    }
  }

  &__name {
    width: 76px;
    flex-shrink: 0;
    font-size: 13px;
    color: var(--tp-text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__bar {
    flex: 1;
    height: 8px;
    background: var(--el-fill-color-light);
    border-radius: 4px;
    overflow: hidden;
  }

  &__bar-fill {
    display: block;
    height: 100%;
    background: var(--el-color-primary);
    border-radius: 4px;
  }

  &__count {
    width: 36px;
    text-align: right;
    font-size: 13px;
    color: var(--tp-text-primary);
  }

  &__pct {
    width: 42px;
    text-align: right;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }
}
</style>
