<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { Plus } from '@element-plus/icons-vue'

import ProTable from '@/components/business/ProTable.vue'
import QuoteFormDialog from '../components/QuoteFormDialog.vue'
import { fetchQuotes, useQuotesSummary } from '../composables/useQuotes'
import { getCustomers } from '@/api/resources/customers'
import type { CustomerItem, CustomerListReq } from '@/api/types/customers'
import type { QuoteListItem, QuoteTab } from '@/api/types/quotes'
import type { ProColumn } from '@/components/business/pro-table'
import type { FilterField } from '@/components/business/FilterBar.vue'
import { qk } from '@/query/keys'
import { staleTime } from '@/query/options'

defineOptions({ name: 'QuotesListView' })

/**
 * 09 报价列表（FR-01/FR-02，09 §1.1）：
 * 状态 Tab（all + 五状态，附各档数量）→ externalQuery 进 ProTable 全量 key；
 * 关键词（报价编号/客户名）+ 客户筛选；行点击进入详情；「+ 新建报价」弹窗；
 * D8 深链：`?customerId=xxx&create=1`（客户 360° Quotes 页签空态 / AI Insights「创建报价」）
 * → 预置客户筛选 + 直接打开新建弹窗。
 */
const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const queryClient = useQueryClient()

// ===== D8 深链参数 =====
const deepLinkCustomerId = computed(() =>
  typeof route.query.customerId === 'string' ? route.query.customerId : '',
)

/** 预置客户筛选（ProTable 初始筛选值，Tab 切换重挂载后仍生效） */
const defaultQuery = computed<Record<string, unknown>>(() =>
  deepLinkCustomerId.value ? { customerId: deepLinkCustomerId.value } : {},
)

const columns: ProColumn[] = [
  { prop: 'quoteNo', labelKey: 'quotes.quoteNo', width: 170 },
  { prop: 'customerName', labelKey: 'quotes.customer', minWidth: 220 },
  { prop: 'totalAmount', labelKey: 'quotes.amount', width: 160, align: 'right' },
  { prop: 'status', labelKey: 'quotes.status', width: 120, enumGroup: 'quoteStatus' },
  { prop: 'createdAt', labelKey: 'quotes.createdAt', width: 180 },
]

// ===== 状态 Tab（all + 五状态）=====
const tabs: { value: QuoteTab; labelKey: string }[] = [
  { value: 'all', labelKey: 'quotes.tabAll' },
  { value: 'draft', labelKey: 'quotes.tabDraft' },
  { value: 'waiting_approval', labelKey: 'quotes.tabWaitingApproval' },
  { value: 'sent', labelKey: 'quotes.tabSent' },
  { value: 'won', labelKey: 'quotes.tabWon' },
  { value: 'lost', labelKey: 'quotes.tabLost' },
]
const activeTab = ref<QuoteTab>('all')
const { data: summary } = useQuotesSummary()

function tabCount(status: QuoteTab): number {
  return summary.value?.tabs.find((tab) => tab.status === status)?.count ?? 0
}

/** Tab 合并进 ProTable query key（09 §1.1） */
const externalQuery = computed<Record<string, unknown>>(() => ({
  status: activeTab.value === 'all' ? undefined : activeTab.value,
}))

// ===== 客户筛选（提供 FilterBar 以启用内置关键词搜索；pageSize 上限 100，接口规范 §2.3）=====
const { data: customers } = useQuery({
  queryKey: [...qk.quotes.all, 'customer-options'],
  queryFn: () => getCustomers({ page: 1, pageSize: 100 } as CustomerListReq),
  staleTime: staleTime.DICT,
})

const filters = computed<FilterField[]>(() => [
  {
    prop: 'customerId',
    labelKey: 'quotes.customer',
    type: 'select',
    width: 220,
    options: (customers.value?.items ?? []).map((item: CustomerItem) => ({
      value: item.customerId,
      label: item.companyName,
    })),
  },
])

const formVisible = ref(false)

/** D8：create=1 时打开新建弹窗并带入客户，随后清除该参数（避免刷新重复弹窗） */
watch(
  () => route.query.create,
  (flag) => {
    if (flag !== '1') return
    formVisible.value = true
    void router.replace({
      name: 'quotes',
      query: deepLinkCustomerId.value ? { customerId: deepLinkCustomerId.value } : {},
    })
  },
  { immediate: true },
)

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString()
}

function onRowClick(row: QuoteListItem) {
  void router.push({ name: 'quote-detail', params: { id: row.quoteId } })
}

function onSaved(quoteId: string) {
  void queryClient.invalidateQueries({ queryKey: qk.quotes.all })
  void router.push({ name: 'quote-detail', params: { id: quoteId } })
}
</script>

<template>
  <div class="quotes">
    <div class="quotes__header">
      <h3 class="quotes__title">{{ t('menu.quotes') }}</h3>
      <el-button type="primary" @click="formVisible = true">
        <el-icon><Plus /></el-icon>{{ t('quotes.newQuote') }}
      </el-button>
    </div>

    <el-tabs v-model="activeTab" class="quotes__tabs">
      <el-tab-pane v-for="tab in tabs" :key="tab.value" :name="tab.value">
        <template #label>
          <span>{{ t(tab.labelKey) }}</span>
          <span class="quotes__tab-count">{{ tabCount(tab.value) }}</span>
        </template>
      </el-tab-pane>
    </el-tabs>

    <ProTable
      :key="activeTab"
      :columns="columns"
      :fetcher="fetchQuotes"
      :query-key-base="qk.quotes.all"
      :filters="filters"
      :external-query="externalQuery"
      :default-query="defaultQuery"
      row-key="quoteId"
      @row-click="onRowClick"
    >
      <template #col-totalAmount="{ row }">{{ row.currency }} {{ row.totalAmount }}</template>
      <template #col-createdAt="{ row }">{{ formatDateTime(row.createdAt) }}</template>
    </ProTable>

    <QuoteFormDialog
      v-model="formVisible"
      mode="create"
      :preset-customer-id="deepLinkCustomerId"
      @saved="onSaved"
    />
  </div>
</template>

<style scoped lang="scss">
.quotes {
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
