<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'

import EmptyState from '@/components/business/EmptyState.vue'
import ProductDetailDrawer from '@/components/business/ProductDetailDrawer.vue'
import { getCustomerProducts } from '@/api/resources/customers'
import type { CustomerProductItem } from '@/api/types/customers'
import { qk } from '@/query/keys'
import { staleTime } from '@/query/options'

/**
 * ProductsPanel Products 页签（04 §1.5 / D7）：
 * productMatches 列表；行点击展开行内详情抽屉（P0 不跳 08，跳转随产品中心启用）。
 */
const props = defineProps<{ entityId: string }>()

const { t } = useI18n()

const productsQuery = useQuery({
  queryKey: computed(() => qk.customer360.products(props.entityId)),
  queryFn: () => getCustomerProducts(props.entityId),
  staleTime: staleTime.DETAIL,
})

watch(
  () => props.entityId,
  () => {
    drawerVisible.value = false
    selected.value = null
  },
)

const list = computed(() => productsQuery.data.value ?? [])

const drawerVisible = ref(false)
const selected = ref<CustomerProductItem | null>(null)

function openDetail(product: CustomerProductItem) {
  selected.value = product
  drawerVisible.value = true
}
</script>

<template>
  <div class="products-panel">
    <el-skeleton v-if="productsQuery.isLoading.value" :rows="4" animated />

    <template v-else>
      <div v-if="list.length" class="products-panel__table">
        <div class="products-panel__head">
          <span class="products-panel__col products-panel__col--name">{{
            t('c360.productName')
          }}</span>
          <span class="products-panel__col">{{ t('c360.productMatch') }}</span>
          <span class="products-panel__col products-panel__col--action" />
        </div>
        <div
          v-for="p in list"
          :key="p.productId"
          class="products-panel__row"
          @click="openDetail(p)"
        >
          <span class="products-panel__col products-panel__col--name">
            <span class="products-panel__name">{{ p.productName }}</span>
            <el-tag v-if="p.category" size="small" effect="plain">{{ p.category }}</el-tag>
          </span>
          <span class="products-panel__col">
            <div class="products-panel__bar">
              <div
                class="products-panel__bar-fill"
                :style="{ width: `${Math.max(0, Math.min(100, p.matchPct))}%` }"
              />
            </div>
          </span>
          <span class="products-panel__col products-panel__col--action">
            <span class="products-panel__pct">{{ p.matchPct }}%</span>
            <el-button link type="primary" size="small" @click.stop="openDetail(p)">
              {{ t('c360.productViewDetail') }}
            </el-button>
          </span>
        </div>
      </div>
      <EmptyState
        v-else
        class="products-panel__empty"
        :title="t('c360.productsEmpty')"
        :description="t('c360.productsEmptyHint')"
      />
    </template>

    <ProductDetailDrawer v-model="drawerVisible" :product="selected" />
  </div>
</template>

<style scoped lang="scss">
.products-panel {
  &__table {
    border: 1px solid var(--tp-border-color);
    border-radius: 8px;
    overflow: hidden;
  }

  &__head,
  &__row {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 0 16px;
  }

  &__head {
    height: 40px;
    background: var(--tp-bg-hover);
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__row {
    min-height: 56px;
    border-top: 1px solid var(--tp-border-color);
    cursor: pointer;

    &:hover {
      background: color-mix(in srgb, var(--tp-primary) 6%, transparent);
    }
  }

  &__col {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;

    &--name {
      flex: 2;
    }

    &--action {
      flex: 0 0 auto;
      justify-content: flex-end;
    }
  }

  &__name {
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__bar {
    flex: 1;
    max-width: 260px;
    height: 8px;
    border-radius: 4px;
    background: var(--tp-bg-hover);
    overflow: hidden;
  }

  &__bar-fill {
    height: 100%;
    border-radius: 4px;
    background: linear-gradient(90deg, var(--ai-waiting), var(--ai-working));
  }

  &__pct {
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__empty {
    padding: 24px 0;
  }
}
</style>
