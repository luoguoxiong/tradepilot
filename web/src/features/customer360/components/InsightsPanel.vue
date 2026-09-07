<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'

import ContactDetailDrawer from '@/components/business/ContactDetailDrawer.vue'
import EmptyState from '@/components/business/EmptyState.vue'
import InsightCard from '@/components/business/InsightCard.vue'
import OutreachDraftDialog from '@/components/business/OutreachDraftDialog.vue'
import { getCustomerContacts, getCustomerInsight } from '@/api/resources/customers'
import type { ContactItem, Customer360Insight, Customer360NextAction } from '@/api/types/customers'
import type { PageResp } from '@/api/types/common'
import { qk } from '@/query/keys'
import { staleTime } from '@/query/options'
import { features } from '@/features'
import { useOutreachDraft } from '@/features/customer360/composables/useOutreachDraft'

/**
 * InsightsPanel AI Insights 页签（04 §1.3 / FR-05）：
 * InsightCard 证据链展示采购概率 + 推荐下一步动作；
 * 「重新分析」→ 父级 useCustomerAnalyze（scope=full 精化联系人决策影响力），弹层进度随头部共用。
 */
const props = withDefaults(
  defineProps<{
    entityId: string
    /** 分析任务进行中（父级共享 running），用于按钮 loading */
    analyzing?: boolean
    onAnalyze?: (scope: 'overview' | 'full') => void
  }>(),
  { analyzing: false, onAnalyze: undefined },
)

const { t } = useI18n()

const insightQuery = useQuery({
  queryKey: computed(() => qk.customer360.insight(props.entityId)),
  queryFn: () => getCustomerInsight(props.entityId),
  staleTime: staleTime.DETAIL,
})

const insight = computed<Customer360Insight | null>(() => insightQuery.data.value ?? null)

/** 下一步动作：send_quote 依赖 09（D8），P0 按 features 过滤不展示 */
const visibleAction = computed<Customer360NextAction | null>(() => {
  const action = insight.value?.nextAction
  if (!action) return null
  if (action.type === 'send_quote' && !features.quotes) return null
  return action
})

const hasInsight = computed(
  () => Boolean(insight.value?.purchaseProbability) || Boolean(visibleAction.value),
)

// ===== 联系人解析（open drawer / 无 targetId 的开发信兜底） =====
const resolverQuery = useQuery<PageResp<ContactItem>>({
  queryKey: computed(() => qk.customer360.contacts(props.entityId, { page: 1, pageSize: 100 })),
  queryFn: () => getCustomerContacts(props.entityId, { page: 1, pageSize: 100 }),
  enabled: computed(() => Boolean(visibleAction.value?.targetId)),
  staleTime: staleTime.DETAIL,
})

const targetContact = computed<ContactItem | null>(() => {
  const targetId = visibleAction.value?.targetId
  if (!targetId) return null
  return resolverQuery.data.value?.list.find((c) => c.contactId === targetId) ?? null
})

// ===== 推荐动作执行（04 §1.3：点击触发，建议不自动执行） =====
const outreach = useOutreachDraft()
const drawerVisible = ref(false)
const drawerContact = ref<ContactItem | null>(null)

function execute(action: Customer360NextAction) {
  if (action.type === 'generate_outreach') {
    const contactId = action.targetId ?? targetContact.value?.contactId
    if (contactId) {
      void outreach.generate(contactId, 'quote_followup')
    } else {
      ElMessage.warning(t('c360.nextActionNoContact'))
    }
    return
  }
  if (action.type === 'contact_decision_maker') {
    if (targetContact.value) {
      drawerContact.value = targetContact.value
      drawerVisible.value = true
    } else {
      ElMessage.warning(t('c360.nextActionNoContact'))
    }
    return
  }
  // send_quote：09 启用（features.quotes）后引导创建报价；当前不渲染该按钮
}

function analyze() {
  props.onAnalyze?.('full')
}
</script>

<template>
  <div class="insights-panel">
    <el-skeleton v-if="insightQuery.isLoading.value" :rows="5" animated />

    <template v-else>
      <div v-if="hasInsight" class="insights-panel__content">
        <div class="insights-panel__toolbar">
          <el-button size="small" :loading="analyzing" @click="analyze">
            {{ t('c360.reanalyze') }}
          </el-button>
        </div>

        <el-card shadow="never" class="insights-panel__card">
          <InsightCard
            :insight="insight?.purchaseProbability ?? null"
            :value-label="t('c360.purchaseProbability')"
          />
          <template v-if="visibleAction">
            <el-divider />
            <p class="insights-panel__next-title">{{ t('c360.nextActionTitle') }}</p>
            <el-button
              type="primary"
              plain
              class="insights-panel__next-btn"
              @click="execute(visibleAction)"
            >
              {{ visibleAction.label }}
            </el-button>
          </template>
        </el-card>
      </div>

      <div v-else class="insights-panel__empty">
        <EmptyState :title="t('c360.insightEmpty')" :description="t('c360.insightEmptyHint')">
          <el-button type="primary" :loading="analyzing" @click="analyze">
            {{ t('c360.startAnalyze') }}
          </el-button>
        </EmptyState>
      </div>
    </template>

    <ContactDetailDrawer v-model="drawerVisible" :contact="drawerContact" />
    <OutreachDraftDialog
      v-model="outreach.visible.value"
      :loading="outreach.loading.value"
      :draft="outreach.draft.value"
      @regenerate="outreach.regenerate"
      @update:model-value="outreach.close"
    />
  </div>
</template>

<style scoped lang="scss">
.insights-panel {
  &__content {
    max-width: 720px;
  }

  &__toolbar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 10px;
  }

  &__next-title {
    margin: 0 0 10px;
    font-size: 13px;
    font-weight: 600;
    color: var(--tp-text-secondary);
  }

  &__next-btn {
    width: 100%;
  }

  &__empty {
    padding: 24px 0;
  }
}
</style>
