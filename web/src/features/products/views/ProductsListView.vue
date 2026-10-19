<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useQueryClient } from '@tanstack/vue-query'
import { Plus } from '@element-plus/icons-vue'

import ProTable from '@/components/business/ProTable.vue'
import ProductFormDialog from '../components/ProductFormDialog.vue'
import { getProducts } from '@/api/resources/products'
import type { ProductListItem, ProductListQuery } from '@/api/types/products'
import type { ProColumn } from '@/components/business/pro-table'
import type { FilterField } from '@/components/business/FilterBar.vue'
import { qk } from '@/query/keys'

defineOptions({ name: 'ProductsListView' })

/**
 * 08 产品列表（FR-01~03，08 §1.1）：
 * 关键词 + 分类/状态筛选（ProTable 全量参数进 query key）；行点击进入详情；
 * 「+ 添加产品」弹窗（SKU 同企业唯一 42201）。
 */
const { t } = useI18n()
const router = useRouter()
const queryClient = useQueryClient()

const columns: ProColumn[] = [
  { prop: 'name', labelKey: 'products.colName', minWidth: 240 },
  { prop: 'sku', labelKey: 'products.colSku', width: 140 },
  { prop: 'category', labelKey: 'products.colCategory', width: 140 },
  { prop: 'moq', labelKey: 'products.colMoq', width: 160 },
  { prop: 'status', labelKey: 'products.colStatus', width: 120, enumGroup: 'productStatus' },
]

const filters: FilterField[] = [
  { prop: 'category', labelKey: 'products.filterCategory', type: 'input' },
  {
    prop: 'status',
    labelKey: 'products.filterStatus',
    type: 'select',
    enumGroup: 'productStatus',
  },
]

const formVisible = ref(false)

/** ProTable 传入全量参数（含 scope/sortBy），此处收窄为客户列表契约 */
const fetchProducts = (params: Record<string, unknown>) => getProducts(params as ProductListQuery)

function onRowClick(row: ProductListItem) {
  void router.push({ name: 'product-detail', params: { id: row.productId } })
}

function onSaved(productId: string) {
  void queryClient.invalidateQueries({ queryKey: qk.products.all })
  void router.push({ name: 'product-detail', params: { id: productId } })
}
</script>

<template>
  <div class="products">
    <div class="products__header">
      <h3 class="products__title">{{ t('menu.products') }}</h3>
      <el-button type="primary" @click="formVisible = true">
        <el-icon><Plus /></el-icon>{{ t('products.add') }}
      </el-button>
    </div>

    <ProTable
      :columns="columns"
      :fetcher="fetchProducts"
      :query-key-base="qk.products.all"
      :filters="filters"
      row-key="productId"
      @row-click="onRowClick"
    >
      <template #col-name="{ row }">
        <div class="products__name">
          <img v-if="row.image" class="products__thumb" :src="row.image" alt="" />
          <span v-else class="products__thumb products__thumb--empty" />
          <span>{{ row.name }}</span>
        </div>
      </template>
      <template #col-moq="{ row }">{{ row.moq }} {{ row.moqUnit }}</template>
    </ProTable>

    <ProductFormDialog v-model="formVisible" mode="create" @saved="onSaved" />
  </div>
</template>

<style scoped lang="scss">
.products {
  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: calc(var(--tp-spacing-base) * 3);
  }

  &__title {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__name {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  &__thumb {
    width: 32px;
    height: 32px;
    border-radius: var(--tp-border-radius-base);
    object-fit: cover;
    flex-shrink: 0;

    &--empty {
      background: var(--tp-bg-hover);
    }
  }
}
</style>
