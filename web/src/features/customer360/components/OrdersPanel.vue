<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'

import AiStatusTag from '@/components/business/AiStatusTag.vue'
import EmptyState from '@/components/business/EmptyState.vue'
import MoneyText from '@/components/business/MoneyText.vue'
import { getOrders } from '@/api/resources/orders'
import type { OrderListItem, OrderListResp } from '@/api/types/orders'
import { qk } from '@/query/keys'
import { listQueryOptions } from '@/query/options'
import { DEFAULT_TIMEZONE, formatInOrgTz } from '@/utils/date'

/**
 * OrdersPanel Orders 页签（04 §1.4 / FR-07，D6）：
 * 数据源 = 10 订单列表接口的客户维度过滤（`customerId`），不另建存储；
 * 行点击跳 10 订单详情（订单号 / 状态 / 履约风险 / 金额 / 交期）。
 */
const props = withDefaults(defineProps<{ entityId: string; timezone?: string }>(), {
  timezone: DEFAULT_TIMEZONE,
})

const { t } = useI18n()
const router = useRouter()

const page = ref(1)
const pageSize = 10

const filters = computed(() => ({ customerId: props.entityId, page: page.value, pageSize }))

const ordersQuery = useQuery<OrderListResp>({
  queryKey: computed(() => qk.orders.list(filters.value)),
  queryFn: () => getOrders(filters.value),
  ...listQueryOptions(),
})

watch(
  () => props.entityId,
  () => {
    page.value = 1
  },
)

const list = computed<OrderListItem[]>(() => ordersQuery.data.value?.items ?? [])
const total = computed(() => ordersQuery.data.value?.total ?? 0)

function openOrder(row: OrderListItem) {
  void router.push({ name: 'order-detail', params: { id: row.orderId } })
}

function dateText(value: string): string {
  return value ? formatInOrgTz(value, props.timezone, 'YYYY-MM-DD') : '—'
}
</script>

<template>
  <div class="orders-panel">
    <el-skeleton v-if="ordersQuery.isLoading.value" :rows="4" animated />

    <template v-else>
      <div v-if="list.length" class="orders-panel__list">
        <div
          v-for="row in list"
          :key="row.orderId"
          class="orders-panel__item"
          role="button"
          @click="openOrder(row)"
        >
          <div class="orders-panel__main">
            <span class="orders-panel__no">{{ row.orderNo }}</span>
            <AiStatusTag group="orderStatus" :value="row.status" />
            <AiStatusTag v-if="row.risk" group="orderRisk" :value="row.risk" />
          </div>
          <div class="orders-panel__meta">
            <MoneyText class="orders-panel__amount" :amount="row.amount" :currency="row.currency" />
            <span class="orders-panel__date">{{ dateText(row.deliveryDate) }}</span>
          </div>
        </div>
      </div>

      <EmptyState
        v-else
        class="orders-panel__empty"
        :title="t('c360.ordersEmpty')"
        :description="t('c360.ordersEmptyHint')"
      />

      <el-pagination
        v-if="total > pageSize"
        class="orders-panel__pager"
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
.orders-panel {
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
