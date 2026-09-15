<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useQueryClient } from '@tanstack/vue-query'
import { Plus } from '@element-plus/icons-vue'

import ProTable from '@/components/business/ProTable.vue'
import OrderFormDialog from '../components/OrderFormDialog.vue'
import { fetchOrders, useOrdersSummary } from '../composables/useOrders'
import type { OrderListItem, OrderTab } from '@/api/types/orders'
import type { ProColumn } from '@/components/business/pro-table'
import type { FilterField } from '@/components/business/FilterBar.vue'
import { qk } from '@/query/keys'

defineOptions({ name: 'OrdersListView' })

/**
 * 10 订单列表（10 §1.1/§2，FR-01）：
 * 状态 Tab（all + 四状态，附各档数量）+ 履约风险筛选 → 全量参数进 ProTable query key；
 * 行点击进入详情，行内风险徽标由 dictStore 语义色渲染（at_risk 红色告警口径）。
 */
const { t } = useI18n()
const router = useRouter()
const queryClient = useQueryClient()

const columns: ProColumn[] = [
  { prop: 'orderNo', labelKey: 'orders.orderNo', width: 170 },
  { prop: 'customerName', labelKey: 'orders.customer', minWidth: 220 },
  { prop: 'amount', labelKey: 'orders.amount', width: 160, align: 'right' },
  { prop: 'status', labelKey: 'orders.status', width: 120, enumGroup: 'orderStatus' },
  { prop: 'risk', labelKey: 'orders.risk', width: 120, enumGroup: 'orderRisk' },
  { prop: 'deliveryDate', labelKey: 'orders.deliveryDate', width: 130 },
  { prop: 'createdAt', labelKey: 'orders.createdAt', width: 180 },
]

/** 状态 Tab（all + 四状态，10 §1.1） */
const tabs: { value: OrderTab; labelKey: string }[] = [
  { value: 'all', labelKey: 'orders.tabAll' },
  { value: 'pending_payment', labelKey: 'orders.tabPendingPayment' },
  { value: 'in_production', labelKey: 'orders.tabInProduction' },
  { value: 'ready_to_ship', labelKey: 'orders.tabReadyToShip' },
  { value: 'completed', labelKey: 'orders.tabCompleted' },
]
const activeTab = ref<OrderTab>('all')
const { data: summary } = useOrdersSummary()

function tabCount(status: OrderTab): number {
  return summary.value?.tabs.find((tab) => tab.status === status)?.count ?? 0
}

const externalQuery = computed<Record<string, unknown>>(() => ({
  tab: activeTab.value,
}))

/** 履约风险筛选（10 §2 risk，与 Tab 可叠加） */
const filters: FilterField[] = [
  {
    prop: 'risk',
    labelKey: 'orders.riskFilter',
    type: 'select',
    enumGroup: 'orderRisk',
    width: 180,
  },
]

const formVisible = ref(false)

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString()
}

function onRowClick(row: OrderListItem) {
  void router.push({ name: 'order-detail', params: { id: row.orderId } })
}

function onSaved(orderId: string) {
  void queryClient.invalidateQueries({ queryKey: qk.orders.all })
  void router.push({ name: 'order-detail', params: { id: orderId } })
}
</script>

<template>
  <div class="orders">
    <div class="orders__header">
      <h3 class="orders__title">{{ t('orders.title') }}</h3>
      <el-button type="primary" @click="formVisible = true">
        <el-icon><Plus /></el-icon>{{ t('orders.newOrder') }}
      </el-button>
    </div>

    <el-tabs v-model="activeTab" class="orders__tabs">
      <el-tab-pane v-for="tab in tabs" :key="tab.value" :name="tab.value">
        <template #label>
          <span>{{ t(tab.labelKey) }}</span>
          <span class="orders__tab-count">{{ tabCount(tab.value) }}</span>
        </template>
      </el-tab-pane>
    </el-tabs>

    <ProTable
      :key="activeTab"
      :columns="columns"
      :fetcher="fetchOrders"
      :query-key-base="qk.orders.all"
      :filters="filters"
      :external-query="externalQuery"
      :searchable="false"
      row-key="orderId"
      @row-click="onRowClick"
    >
      <template #col-amount="{ row }">{{ row.currency }} {{ row.amount }}</template>
      <template #col-createdAt="{ row }">{{ formatDateTime(row.createdAt) }}</template>
    </ProTable>

    <OrderFormDialog v-model="formVisible" mode="create" @saved="onSaved" />
  </div>
</template>

<style scoped lang="scss">
.orders {
  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: calc(var(--tp-spacing-base) * 2);
  }

  &__title {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__tabs {
    margin-bottom: calc(var(--tp-spacing-base) * 2);
  }

  &__tab-count {
    margin-left: 6px;
    padding: 0 6px;
    font-size: 12px;
    color: var(--tp-text-secondary);
    background: var(--tp-bg-hover);
    border-radius: 8px;
  }
}
</style>
