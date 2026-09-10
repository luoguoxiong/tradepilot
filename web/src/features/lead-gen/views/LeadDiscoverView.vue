<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'

import ProTable from '@/components/business/ProTable.vue'
import InsightCard from '@/components/business/InsightCard.vue'
import type { ProColumn } from '@/components/business/pro-table'
import { addLeadsToCrm, getLeads, getLeadsSummary } from '@/api/resources/leads'
import type { ApiError } from '@/api/http'
import { handleApiError } from '@/api/error-handler'
import type { LeadItem, LeadListReq } from '@/api/types/leads'
import { staleTime } from '@/query/options'
import { qk } from '@/query/keys'

defineOptions({ name: 'LeadDiscoverView' })

/**
 * 客户发现列表（03 §1.6 / 04 §3.3）：
 * Tab = 价值档 + 已加入 CRM（计数来自 /leads/summary）；ProTable 分页筛选；
 * 匹配度列评分环 hover 展示 InsightCard（04 §2.1 完整证据链：置信度/原因/引用溯源）；
 * 加入 CRM 走批量接口 + 乐观更新（行级 40301 回滚报错）。
 */
const { t } = useI18n()
const queryClient = useQueryClient()
const router = useRouter()

// ===== 价值档 Tab（计数 30s 聚合口径） =====
const activeTab = ref<'all' | 'high' | 'medium' | 'low' | 'inCrm'>('all')

const summaryQuery = useQuery({
  queryKey: qk.leads.summary(),
  queryFn: getLeadsSummary,
  staleTime: staleTime.DETAIL,
})

const tabCount = (key: 'all' | 'high' | 'medium' | 'low' | 'inCrm') =>
  summaryQuery.data.value?.[key] ?? 0

/** Tab → 服务端筛选参数（03 §3.3 valueLevel/inCrm） */
const externalQuery = computed<Record<string, unknown>>(() => {
  if (activeTab.value === 'inCrm') return { inCrm: true }
  if (activeTab.value === 'all') return {}
  return { valueLevel: activeTab.value }
})

const columns: ProColumn[] = [
  { prop: 'companyName', labelKey: 'leadGen.company', minWidth: 180, fixed: 'left' },
  { prop: 'country', labelKey: 'leadGen.country', width: 90 },
  { prop: 'industry', labelKey: 'leadGen.industry', minWidth: 120 },
  { prop: 'matchPct', labelKey: 'leadGen.matchPct', width: 120, sortable: 'custom' },
  { prop: 'scoreLevel', labelKey: 'leadGen.scoreLevel', width: 100, enumGroup: 'leadValue' },
  { prop: 'inCrm', labelKey: 'leadGen.crmState', width: 100 },
  { prop: 'actions', labelKey: 'settings.actions', width: 150, fixed: 'right' },
]

/** ProTable 统一 query 形状 → LeadListReq（泛型推断 T = LeadItem） */
const fetchLeads = (params: Record<string, unknown>) => getLeads(params as LeadListReq)

// ===== 加入 CRM（批量 + 乐观更新 + 40301 行级回滚） =====
const tableRef = ref<{ clearSelection: () => void } | null>(null)

const addMutation = useMutation({
  mutationFn: (leadIds: string[]) => addLeadsToCrm({ leadIds }),
  onMutate: async (leadIds) => {
    // 乐观置 inCrm（全部命中缓存列表）；失败由 onError 快照回滚
    const snapshots = queryClient.getQueriesData<unknown>({ queryKey: qk.leads.all })
    for (const [key, data] of snapshots) {
      if (!data || typeof data !== 'object') continue
      const page = data as { items?: LeadItem[] }
      if (!Array.isArray(page.items)) continue
      for (const row of page.items) {
        if (leadIds.includes(row.leadId)) row.inCrm = true
      }
      queryClient.setQueryData(key, data)
    }
    return { snapshots }
  },
  onError: (error: ApiError, _leadIds, ctx) => {
    // 回滚乐观更新
    for (const [key, data] of ctx?.snapshots ?? []) {
      queryClient.setQueryData(key, data)
    }
    handleApiError(error, { forbiddenMessage: t('leadGen.addCrmForbidden') })
  },
  onSuccess: (resp) => {
    ElMessage.success(
      t('leadGen.addCrmSuccess', { created: resp.created, duplicated: resp.duplicated }),
    )
    tableRef.value?.clearSelection()
  },
  onSettled: () => {
    void queryClient.invalidateQueries({ queryKey: qk.leads.all })
    void queryClient.invalidateQueries({ queryKey: qk.leads.summary() })
    void queryClient.invalidateQueries({ queryKey: qk.leadHunterSummary })
  },
})

function addToCrm(leadIds: string[]) {
  if (addMutation.isPending.value) return
  addMutation.mutate(leadIds)
}

/** 查看 360°（lead 预览态 / 已入库 → 客户档案，04 §3.1 双源解析） */
function viewLead(row: LeadItem) {
  router.push(`/customers/${row.leadId}`)
}

/** 批量加入：过滤已转化行，成功后由 onSuccess 清选择 */
function batchAddToCrm(rows: LeadItem[], clear: () => void) {
  const ids = rows.filter((r) => !r.inCrm).map((r) => r.leadId)
  if (ids.length === 0) return
  addMutation.mutate(ids, { onSettled: clear })
}
</script>

<template>
  <div class="lead-discover">
    <el-tabs v-model="activeTab" class="lead-discover__tabs">
      <el-tab-pane name="all">
        <template #label>{{ t('leadGen.tabAll') }} ({{ tabCount('all') }})</template>
      </el-tab-pane>
      <el-tab-pane name="high">
        <template #label>{{ t('leadGen.tabHigh') }} ({{ tabCount('high') }})</template>
      </el-tab-pane>
      <el-tab-pane name="medium">
        <template #label>{{ t('leadGen.tabMedium') }} ({{ tabCount('medium') }})</template>
      </el-tab-pane>
      <el-tab-pane name="low">
        <template #label>{{ t('leadGen.tabLow') }} ({{ tabCount('low') }})</template>
      </el-tab-pane>
      <el-tab-pane name="inCrm">
        <template #label>{{ t('leadGen.tabInCrm') }} ({{ tabCount('inCrm') }})</template>
      </el-tab-pane>
    </el-tabs>

    <ProTable
      ref="tableRef"
      :columns="columns"
      :fetcher="fetchLeads"
      :query-key-base="qk.leads.all"
      :external-query="externalQuery"
      row-key="leadId"
      selectable
      :page-size="10"
      @row-click="viewLead"
    >
      <!-- 匹配度列：评分环 hover 展示 InsightCard（04 §2.1 / §3.3） -->
      <template #col-matchPct="{ row }">
        <el-popover placement="top" :width="340" trigger="hover" :disabled="!row.matchReasons">
          <template #reference>
            <span class="lead-discover__match">
              <el-progress
                type="dashboard"
                :percentage="row.matchPct"
                :width="44"
                :stroke-width="5"
                :color="
                  row.scoreLevel === 'high'
                    ? 'var(--ai-working)'
                    : row.scoreLevel === 'medium'
                      ? 'var(--ai-waiting)'
                      : 'var(--ai-idle)'
                "
              />
              <span class="lead-discover__match-hint">AI</span>
            </span>
          </template>
          <InsightCard
            v-if="row.matchReasons"
            :insight="row.matchReasons"
            :value-label="t('leadGen.matchPct')"
          />
        </el-popover>
      </template>

      <!-- 状态列：已转化 / 未转化 -->
      <template #col-inCrm="{ row }">
        <el-tag v-if="row.inCrm" size="small" type="success">{{ t('leadGen.inCrmYes') }}</el-tag>
        <span v-else class="lead-discover__new">{{ t('leadGen.inCrmNo') }}</span>
      </template>

      <!-- 行内操作：查看 360° + 加入 CRM -->
      <template #col-actions="{ row }">
        <el-button link type="primary" size="small" @click.stop="viewLead(row)">
          {{ t('crm.viewDetail') }}
        </el-button>
        <el-button
          link
          size="small"
          :disabled="row.inCrm || addMutation.isPending.value"
          @click.stop="addToCrm([row.leadId])"
        >
          {{ t('leadGen.addToCrm') }}
        </el-button>
      </template>

      <!-- 批量操作条 -->
      <template #batch="{ rows, clear }">
        <el-button
          type="primary"
          size="small"
          :loading="addMutation.isPending.value"
          @click="batchAddToCrm(rows, clear)"
        >
          {{ t('leadGen.batchAddToCrm') }}
        </el-button>
      </template>
    </ProTable>
  </div>
</template>

<style scoped lang="scss">
.lead-discover {
  &__tabs {
    margin-bottom: 4px;
  }

  &__match {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: default;
  }

  &__match-hint {
    position: absolute;
    bottom: -2px;
    font-size: 10px;
    color: var(--tp-text-tertiary);
  }

  &__new {
    color: var(--tp-text-tertiary);
  }
}
</style>
