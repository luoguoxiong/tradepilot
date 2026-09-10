<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import { ElMessage, ElMessageBox } from 'element-plus'

import ProTable from '@/components/business/ProTable.vue'
import InsightCard from '@/components/business/InsightCard.vue'
import type { ProColumn } from '@/components/business/pro-table'
import {
  batchDeleteCustomers,
  batchReassignOwners,
  deleteCustomer,
  getCustomers,
} from '@/api/resources/customers'
import type { CustomerItem, CustomerListReq, CustomerTab } from '@/api/types/customers'
import type { FilterField } from '@/components/business/FilterBar.vue'
import type { ApiError } from '@/api/http'
import { qk } from '@/query/keys'
import { usePermission } from '@/composables/usePermission'
import { useNotifyStore } from '@/stores/notify'
import { formatRelative } from '@/utils/date'
import type { OwnerOption } from './CustomerFormDialog.vue'

/**
 * 客户列表（05 §1.1 客户行 / §3.5 批量）：
 * 四页签的潜在/正式两页复用本组件，仅 tab 参数不同；
 * 批量改派/删除与单条删除均走乐观更新 + 失败快照回滚（40901/40301 兜底）；
 * Cold 客户 reactivateSuggestion 用 InsightCard 展示 AI 建议证据链（04 §2.1）。
 */
const props = withDefaults(
  defineProps<{
    tab: CustomerTab
    ownerOptions?: OwnerOption[]
  }>(),
  { ownerOptions: () => [] },
)

const emit = defineEmits<{
  /** 行「编辑」→ 父级打开表单 */
  edit: [customer: CustomerItem]
}>()

const { t } = useI18n()
const router = useRouter()
const queryClient = useQueryClient()
const { canManage } = usePermission()
const notify = useNotifyStore()

// ===== 筛选 schema（05 §1.1：country / stage / ownerId / keyword） =====
const filters = computed<FilterField[]>(() => [
  { prop: 'country', labelKey: 'crm.country', type: 'select', enumGroup: 'country' },
  { prop: 'stage', labelKey: 'crm.stage', type: 'select', enumGroup: 'customerStage' },
  { prop: 'ownerId', labelKey: 'crm.owner', type: 'select', options: props.ownerOptions },
])

const columns: ProColumn[] = [
  { prop: 'companyName', labelKey: 'crm.company', minWidth: 200, fixed: 'left' },
  { prop: 'country', labelKey: 'crm.country', width: 100, enumGroup: 'country' },
  { prop: 'stage', labelKey: 'crm.stage', width: 105, enumGroup: 'customerStage' },
  { prop: 'lastActivityAt', labelKey: 'crm.lastActivity', minWidth: 130, sortable: 'custom' },
  { prop: 'ownerName', labelKey: 'crm.owner', width: 100 },
  { prop: 'nextAction', labelKey: 'crm.nextAction', minWidth: 150 },
  { prop: 'reactivateSuggestion', labelKey: 'crm.aiSuggestion', minWidth: 160 },
  { prop: 'actions', labelKey: 'settings.actions', width: 130, fixed: 'right' },
]

const fetchCustomers = (params: Record<string, unknown>) => getCustomers(params as CustomerListReq)

const tableRef = ref<{ clearSelection: () => void } | null>(null)

// ===== nextAction 语义色（05 §1.1；随模块交付后开放跳转） =====
const ACTION_TYPE: Record<string, string> = {
  send_quote: 'var(--tp-stage-negotiation)',
  follow_up: 'var(--tp-stage-contacted)',
  send_outreach: 'var(--ai-scheduled)',
  reactivate_ai: 'var(--tp-stage-cold)',
}

function goDetail(row: CustomerItem) {
  router.push(`/customers/${row.customerId}`)
}

// ===== 乐观更新工具：遍历 customers 缓存页批量打补丁（03 §3.4 LeadDiscover 样板） =====
function patchCustomers(apply: (row: CustomerItem) => void) {
  const snapshots = queryClient.getQueriesData<unknown>({ queryKey: qk.customers.all })
  for (const [key, data] of snapshots) {
    if (!data || typeof data !== 'object') continue
    const page = data as { items?: CustomerItem[] }
    if (!Array.isArray(page.items)) continue
    for (const row of page.items) apply(row)
    queryClient.setQueryData(key, data)
  }
  return snapshots
}

function restoreSnapshots(snapshots: ReturnType<typeof patchCustomers> | undefined) {
  for (const [key, data] of snapshots ?? []) {
    queryClient.setQueryData(key, data)
  }
}

function notifyRefresh() {
  void notify.refresh()
}

// ===== 单条删除（生成 customer_delete 审批，乐观置 deleteLocked） =====
const deleteOneMutation = useMutation({
  mutationFn: (customer: CustomerItem) => deleteCustomer(customer.customerId),
  onMutate: async (customer) => {
    const snapshots = patchCustomers((row) => {
      if (row.customerId === customer.customerId) row.deleteLocked = true
    })
    return { snapshots }
  },
  onError: (error: ApiError, _customer, ctx) => {
    restoreSnapshots(ctx?.snapshots ?? [])
    if (error.code === 40301) ElMessage.error(t('crm.deleteForbidden'))
    else ElMessage.error(error.message || t('common.operationFailed'))
  },
  onSuccess: () => {
    ElMessage.success(t('crm.deleteSubmitted'))
    notifyRefresh()
  },
  onSettled: () => {
    void queryClient.invalidateQueries({ queryKey: qk.customers.all })
    tableRef.value?.clearSelection()
  },
})

async function confirmDelete(customer: CustomerItem) {
  if (deleteOneMutation.isPending.value || customer.deleteLocked) return
  try {
    await ElMessageBox.confirm(t('crm.deleteConfirm'), {
      type: 'warning',
      confirmButtonText: t('common.delete'),
      cancelButtonText: t('common.cancel'),
    })
  } catch {
    return
  }
  deleteOneMutation.mutate(customer)
}

// ===== 批量删除（逐客户审批，乐观置 deleteLocked） =====
const batchDeleteMutation = useMutation({
  mutationFn: (customerIds: string[]) => batchDeleteCustomers({ customerIds }),
  onMutate: async (customerIds) => {
    const snapshots = patchCustomers((row) => {
      if (customerIds.includes(row.customerId)) row.deleteLocked = true
    })
    return { snapshots }
  },
  onError: (error: ApiError, _ids, ctx) => {
    restoreSnapshots(ctx?.snapshots ?? [])
    ElMessage.error(error.message || t('common.operationFailed'))
  },
  onSuccess: (resp) => {
    if (resp.failed.length > 0) {
      ElMessage.warning(
        t('crm.batchDeletePartial', { failed: resp.failed.length, created: resp.approvals.length }),
      )
    } else {
      ElMessage.success(t('crm.deleteSubmitted'))
    }
    notifyRefresh()
  },
  onSettled: () => {
    void queryClient.invalidateQueries({ queryKey: qk.customers.all })
  },
})

async function batchDelete(rows: CustomerItem[], clear: () => void) {
  const ids = rows.map((r) => r.customerId)
  if (ids.length === 0) return
  try {
    await ElMessageBox.confirm(t('crm.deleteBatchConfirm', { count: ids.length }), {
      type: 'warning',
      confirmButtonText: t('common.delete'),
      cancelButtonText: t('common.cancel'),
    })
  } catch {
    return
  }
  batchDeleteMutation.mutate(ids, { onSettled: clear })
}

// ===== 批量改派负责人（经理/管理员；乐观替换 owner） =====
const reassignVisible = ref(false)
const reassignOwnerId = ref('')
const reassignRows = ref<CustomerItem[]>([])

const reassignMutation = useMutation({
  mutationFn: () =>
    batchReassignOwners({
      customerIds: reassignRows.value.map((r) => r.customerId),
      ownerId: reassignOwnerId.value,
    }),
  onMutate: async () => {
    const ownerId = reassignOwnerId.value
    const target = props.ownerOptions.find((o) => o.value === ownerId)
    const snapshots = patchCustomers((row) => {
      if (!reassignRows.value.some((r) => r.customerId === row.customerId)) return
      row.ownerId = ownerId
      row.ownerName = target?.label ?? ownerId
    })
    return { snapshots }
  },
  onError: (error: ApiError, _v, ctx) => {
    restoreSnapshots(ctx?.snapshots ?? [])
    if (error.code === 40301) ElMessage.error(t('crm.reassignForbidden'))
    else ElMessage.error(error.message || t('common.operationFailed'))
  },
  onSuccess: (resp) => {
    ElMessage.success(t('crm.reassigned', { count: resp.updated }))
  },
  onSettled: () => {
    reassignVisible.value = false
    reassignRows.value = []
    reassignOwnerId.value = ''
    void queryClient.invalidateQueries({ queryKey: qk.customers.all })
    void queryClient.invalidateQueries({ queryKey: qk.activities.all })
  },
})

function openReassign(rows: CustomerItem[]) {
  reassignRows.value = [...rows]
  reassignOwnerId.value = ''
  reassignVisible.value = true
}

watch(reassignVisible, (visible) => {
  if (!visible) reassignRows.value = []
})

function submitReassign() {
  if (!reassignOwnerId.value) {
    ElMessage.warning(t('crm.reassignRequired'))
    return
  }
  if (reassignMutation.isPending.value) return
  reassignMutation.mutate()
}
</script>

<template>
  <div class="customer-list">
    <ProTable
      ref="tableRef"
      :columns="columns"
      :filters="filters"
      :fetcher="fetchCustomers"
      :query-key-base="qk.customers.all"
      :external-query="{ tab: props.tab }"
      row-key="customerId"
      selectable
      scopeable
      :page-size="10"
      @row-click="goDetail"
    >
      <!-- 最近活动：相对时间展示（05 §1.1） -->
      <template #col-lastActivityAt="{ row }">
        <span>{{ row.lastActivityAt ? formatRelative(row.lastActivityAt) : '—' }}</span>
      </template>

      <!-- 下一步：AI/规则生成的动作建议（对应模块交付后开放，05 §4） -->
      <template #col-nextAction="{ row }">
        <el-tooltip :content="t('crm.nextActionWip')" placement="top" :disabled="!row.nextAction">
          <el-tag
            v-if="row.nextAction"
            size="small"
            effect="plain"
            class="customer-list__action"
            :style="{
              borderColor: ACTION_TYPE[row.nextAction.type],
              color: ACTION_TYPE[row.nextAction.type],
            }"
          >
            {{ row.nextAction.label }}
          </el-tag>
          <span v-else>—</span>
        </el-tooltip>
      </template>

      <!-- AI 建议列：Cold 客户 reactivateSuggestion 证据链（04 §2.1） -->
      <template #col-reactivateSuggestion="{ row }">
        <el-popover v-if="row.reactivateSuggestion" placement="top" :width="340" trigger="hover">
          <template #reference>
            <el-tag size="small" effect="light" class="customer-list__ai">AI</el-tag>
          </template>
          <InsightCard
            :insight="row.reactivateSuggestion"
            :value-label="t('crm.reactivationScore')"
          />
          <div class="customer-list__reactivate-tip">{{ t('crm.reactivateTip') }}</div>
        </el-popover>
        <span v-else>—</span>
      </template>

      <!-- 行操作：编辑 / 删除（删除 = 发起审批 → deleteLocked） -->
      <template #col-actions="{ row }">
        <el-tag v-if="row.deleteLocked" size="small" type="warning" effect="light" @click.stop>
          {{ t('crm.deletePendingTag') }}
        </el-tag>
        <template v-else>
          <el-button
            link
            type="primary"
            size="small"
            :disabled="deleteOneMutation.isPending.value"
            @click.stop="emit('edit', row)"
          >
            {{ t('crm.edit') }}
          </el-button>
          <el-button
            link
            type="danger"
            size="small"
            :disabled="deleteOneMutation.isPending.value"
            @click.stop="confirmDelete(row)"
          >
            {{ t('crm.delete') }}
          </el-button>
        </template>
      </template>

      <!-- 批量操作条（05 §3.5：改派仅经理/管理员） -->
      <template #batch="{ rows, clear }">
        <el-button
          v-if="canManage"
          size="small"
          :loading="reassignMutation.isPending.value"
          @click="openReassign(rows)"
        >
          {{ t('crm.batchReassign') }}
        </el-button>
        <el-button
          type="danger"
          size="small"
          :loading="batchDeleteMutation.isPending.value"
          @click="batchDelete(rows, clear)"
        >
          {{ t('crm.batchDelete') }}
        </el-button>
      </template>
    </ProTable>

    <!-- 批量改派弹层 -->
    <el-dialog
      v-model="reassignVisible"
      :title="t('crm.reassignTitle')"
      width="420px"
      :append-to-body="true"
    >
      <p class="customer-list__reassign-hint">{{ t('crm.reassignHint') }}</p>
      <el-select v-model="reassignOwnerId" :placeholder="t('crm.reassignTo')" style="width: 100%">
        <el-option
          v-for="opt in ownerOptions"
          :key="opt.value"
          :value="opt.value"
          :label="opt.label"
        />
      </el-select>
      <template #footer>
        <el-button @click="reassignVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button
          type="primary"
          :loading="reassignMutation.isPending.value"
          @click="submitReassign"
        >
          {{ t('common.confirm') }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped lang="scss">
.customer-list {
  &__action {
    font-weight: 500;
  }

  &__ai {
    cursor: default;
    font-weight: 600;
    letter-spacing: 0.5px;
  }

  &__reactivate-tip {
    margin-top: 8px;
    font-size: 12px;
    color: var(--tp-text-tertiary);
    line-height: 1.5;
  }

  &__reassign-hint {
    margin: 0 0 12px;
    font-size: 13px;
    color: var(--tp-text-secondary);
    line-height: 1.6;
  }
}
</style>
