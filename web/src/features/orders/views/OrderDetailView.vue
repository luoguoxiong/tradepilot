<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useQueryClient } from '@tanstack/vue-query'
import { ArrowLeft, Edit, Link } from '@element-plus/icons-vue'

import EmptyState from '@/components/business/EmptyState.vue'
import OrderProgressPanel from '../components/OrderProgressPanel.vue'
import OrderRiskPanel from '../components/OrderRiskPanel.vue'
import OrderFormDialog from '../components/OrderFormDialog.vue'
import { useOrderDetail } from '../composables/useOrders'
import { useDictStore } from '@/stores/dict'
import { qk } from '@/query/keys'

/**
 * 10 订单详情（10 §1.2/§1.3，FR-01~FR-07）：
 * 订单头 + 履约进度（四要素派生状态）+ 明细行 + 风险洞察 + 变更中审批；
 * 金额/交期/数量变更一律走 order_change 高危审批（10 §4），前端不直接改单。
 */
defineOptions({ name: 'OrderDetailView' })

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()
const dict = useDictStore()

const orderId = computed(() => String(route.params.id ?? ''))
const { data: order, isLoading } = useOrderDetail(orderId)

const changeVisible = ref(false)

function statusLabel(): string {
  return dict.label('orderStatus', order.value?.status ?? '')
}

function statusColor(): string {
  return dict.color('orderStatus', order.value?.status ?? '') ?? 'var(--ai-idle)'
}

function riskLabel(): string {
  return dict.label('orderRisk', order.value?.risk ?? '')
}

function riskColor(): string {
  return dict.color('orderRisk', order.value?.risk ?? '') ?? 'var(--ai-idle)'
}

function formatDateTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : '—'
}

async function refresh() {
  await queryClient.invalidateQueries({ queryKey: qk.orders.all })
}

function gotoApproval() {
  const approvalId = order.value?.pendingChange?.approvalId
  if (!approvalId) return
  void router.push({ name: 'approvals', query: { approvalId } })
}

function gotoQuote() {
  const quotationId = order.value?.quotationId
  if (!quotationId) return
  void router.push({ name: 'quote-detail', params: { id: quotationId } })
}

function back() {
  void router.push({ name: 'orders' })
}
</script>

<template>
  <div v-loading="isLoading" class="order-detail">
    <template v-if="order">
      <div class="order-detail__header">
        <div class="order-detail__head-left">
          <el-button link :icon="ArrowLeft" @click="back">{{ t('common.back') }}</el-button>
          <h3 class="order-detail__no">{{ order.orderNo }}</h3>
          <span class="order-detail__status" :style="{ color: statusColor() }">
            {{ statusLabel() }}
          </span>
          <span class="order-detail__risk" :style="{ color: riskColor() }">
            {{ riskLabel() }}
          </span>
          <span class="order-detail__amount">{{ order.currency }} {{ order.amount }}</span>
        </div>
        <div class="order-detail__actions">
          <!-- 变更走 order_change 高危审批；已有在途审批时禁止重复提交（服务端 40901 兜底） -->
          <el-tooltip
            :content="t('orders.pendingChangeTip')"
            :disabled="!order.pendingChange"
            placement="top"
          >
            <span>
              <el-button
                :icon="Edit"
                :disabled="Boolean(order.pendingChange)"
                @click="changeVisible = true"
              >
                {{ t('orders.editOrder') }}
              </el-button>
            </span>
          </el-tooltip>
        </div>
      </div>

      <!-- 变更审批中（10 §3.2） -->
      <el-alert v-if="order.pendingChange" type="warning" :closable="false">
        <template #title>
          <span class="order-detail__alert">
            {{ t('orders.pendingChangeTitle') }}：{{ order.pendingChange.title }}
            <el-button link type="primary" :icon="Link" @click="gotoApproval">
              {{ t('orders.viewApproval') }}
            </el-button>
          </span>
        </template>
      </el-alert>

      <!-- 订单信息（10 §1.2） -->
      <div class="order-detail__section">
        <div class="order-detail__section-title">{{ t('orders.basicInfo') }}</div>
        <el-descriptions :column="3" border size="small">
          <el-descriptions-item :label="t('orders.customer')">
            {{ order.customerName }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('orders.contact')">
            {{ order.contact?.name ?? '—' }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('orders.owner')">
            {{ order.ownerName ?? '—' }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('orders.deliveryDate')">
            {{ order.deliveryDate }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('orders.paymentTerms')">
            {{ order.paymentTerms || '—' }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('orders.currency')">
            {{ order.currency }}
          </el-descriptions-item>
          <el-descriptions-item v-if="order.quotationId" :label="t('orders.sourceQuote')">
            <el-button link type="primary" @click="gotoQuote">{{ order.quotationId }}</el-button>
          </el-descriptions-item>
          <el-descriptions-item :label="t('orders.createdAt')">
            {{ formatDateTime(order.createdAt) }}
          </el-descriptions-item>
        </el-descriptions>
      </div>

      <!-- 明细行（10 §1.3） -->
      <div class="order-detail__section">
        <div class="order-detail__section-title">{{ t('orders.itemsTitle') }}</div>
        <el-table :data="order.items" size="small" border>
          <el-table-column prop="productName" :label="t('orders.product')" min-width="220" />
          <el-table-column prop="quantity" :label="t('orders.quantity')" width="120" />
          <el-table-column prop="unitPrice" :label="t('orders.unitPrice')" width="140" />
          <el-table-column prop="lineTotal" :label="t('orders.lineTotal')" width="160" />
        </el-table>
      </div>

      <div class="order-detail__grid">
        <!-- 履约进度（10 §3.3 / FR-02） -->
        <div class="order-detail__card">
          <OrderProgressPanel
            :order-id="order.orderId"
            :progress="order.progress"
            :timeline="order.timeline"
            @updated="refresh"
          />
        </div>

        <!-- 履约风险（10 §3.4/§3.5，FR-04~FR-07） -->
        <div class="order-detail__card">
          <OrderRiskPanel :order-id="order.orderId" :insight="order.riskInsight" />
        </div>
      </div>
    </template>

    <EmptyState v-else-if="!isLoading" />

    <OrderFormDialog
      v-model="changeVisible"
      mode="change"
      :order="order ?? null"
      @saved="refresh"
    />
  </div>
</template>

<style scoped lang="scss">
.order-detail {
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
    flex-wrap: wrap;
  }

  &__no {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
  }

  &__status,
  &__risk {
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

  &__alert {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  &__section-title {
    margin-bottom: 8px;
    font-size: 14px;
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
    gap: calc(var(--tp-spacing-base) * 2);
  }

  &__card {
    padding: calc(var(--tp-spacing-base) * 1.5);
    border: 1px solid var(--tp-border-color);
    border-radius: var(--tp-radius-base, 8px);
  }
}
</style>
