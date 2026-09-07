<script setup lang="ts">
import { useI18n } from 'vue-i18n'

import type { CustomerProductItem } from '@/api/types/customers'

/**
 * ProductDetailDrawer 产品匹配详情行内抽屉（04 §1.5 / D7）：
 * P0 行点击不跳 08 产品中心，展开行内详情（category/summary/highlights/reasons/sourceDocs）；
 * 跳转随 08 产品中心（P1）启用。
 */
withDefaults(
  defineProps<{
    modelValue: boolean
    product?: CustomerProductItem | null
    loading?: boolean
  }>(),
  { product: null, loading: false },
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const { t } = useI18n()

function close() {
  emit('update:modelValue', false)
}
</script>

<template>
  <el-drawer
    :model-value="modelValue"
    :title="t('c360.productDetail')"
    size="440px"
    append-to-body
    @update:model-value="close"
  >
    <div v-loading="loading" class="product-detail">
      <template v-if="product">
        <div class="product-detail__head">
          <p class="product-detail__name">{{ product.productName }}</p>
          <el-tag v-if="product.category" size="small" effect="plain">
            {{ product.category }}
          </el-tag>
        </div>

        <div class="product-detail__match">
          <span class="product-detail__match-label">{{ t('c360.productMatch') }}</span>
          <div class="product-detail__match-bar">
            <div class="product-detail__match-fill" :style="{ width: `${product.matchPct}%` }" />
          </div>
          <span class="product-detail__match-pct">{{ product.matchPct }}%</span>
        </div>

        <el-divider />

        <template v-if="product.summary">
          <p class="product-detail__section">{{ t('c360.productSummary') }}</p>
          <p class="product-detail__summary">{{ product.summary }}</p>
        </template>

        <template v-if="product.highlights?.length">
          <p class="product-detail__section">{{ t('c360.productHighlights') }}</p>
          <div class="product-detail__highlights">
            <el-tag
              v-for="(h, i) in product.highlights"
              :key="i"
              size="small"
              type="info"
              effect="plain"
            >
              {{ h }}
            </el-tag>
          </div>
        </template>

        <template v-if="product.reasons?.length">
          <p class="product-detail__section">{{ t('c360.productMatchReasons') }}</p>
          <ul class="product-detail__reasons">
            <li v-for="(r, i) in product.reasons" :key="i" class="product-detail__reason">
              <span>{{ r.text }}</span>
              <span v-if="r.evidence || r.source" class="product-detail__reason-meta">
                {{ r.evidence }}{{ r.source ? ` · ${t('insight.source')}：${r.source}` : '' }}
              </span>
            </li>
          </ul>
        </template>

        <template v-if="product.sourceDocs?.length">
          <p class="product-detail__section">{{ t('c360.productSourceDocs') }}</p>
          <div class="product-detail__docs">
            <el-tag
              v-for="(d, i) in product.sourceDocs"
              :key="i"
              size="small"
              effect="plain"
              class="product-detail__doc"
            >
              {{ d.docName }}
            </el-tag>
          </div>
        </template>

        <el-alert
          :title="t('c360.productDrawerWip')"
          type="info"
          :closable="false"
          class="product-detail__wip"
        />
      </template>
      <el-empty v-else-if="!loading" :description="t('common.empty')" />
    </div>
  </el-drawer>
</template>

<style scoped lang="scss">
.product-detail {
  min-height: 120px;

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  &__name {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__match {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 14px;
  }

  &__match-label {
    flex-shrink: 0;
    font-size: 13px;
    color: var(--tp-text-secondary);
  }

  &__match-bar {
    flex: 1;
    height: 8px;
    border-radius: 4px;
    background: var(--tp-bg-hover);
    overflow: hidden;
  }

  &__match-fill {
    height: 100%;
    border-radius: 4px;
    background: var(--tp-primary);
  }

  &__match-pct {
    flex-shrink: 0;
    min-width: 40px;
    text-align: right;
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__section {
    margin: 0 0 8px;
    font-size: 13px;
    font-weight: 600;
    color: var(--tp-text-secondary);
  }

  &__summary {
    margin: 0;
    line-height: 1.6;
    color: var(--tp-text-primary);
  }

  &__highlights,
  &__docs {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  &__reasons {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  &__reason {
    margin-bottom: 8px;
    line-height: 1.5;

    &:last-child {
      margin-bottom: 0;
    }
  }

  &__reason-meta {
    display: block;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__wip {
    margin-top: 16px;
  }
}
</style>
