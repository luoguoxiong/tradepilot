<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'
import { ArrowLeft, Link as LinkIcon, UserFilled } from '@element-plus/icons-vue'

import ActivitiesPanel from '@/features/customer360/components/ActivitiesPanel.vue'
import ContactsPanel from '@/features/customer360/components/ContactsPanel.vue'
import ConversationsPanel from '@/features/customer360/components/ConversationsPanel.vue'
import InsightsPanel from '@/features/customer360/components/InsightsPanel.vue'
import OverviewPanel from '@/features/customer360/components/OverviewPanel.vue'
import ProductsPanel from '@/features/customer360/components/ProductsPanel.vue'
import { useCustomerAnalyze } from '@/features/customer360/composables/useCustomerAnalyze'
import { useOutreachDraft } from '@/features/customer360/composables/useOutreachDraft'
import EmptyState from '@/components/business/EmptyState.vue'
import AnalyzeTaskDialog from '@/components/business/AnalyzeTaskDialog.vue'
import OutreachDraftDialog from '@/components/business/OutreachDraftDialog.vue'
import {
  advanceCustomerStage,
  getCustomer360,
  getCustomerContacts,
} from '@/api/resources/customers'
import { convertLead } from '@/api/resources/leads'
import { ENUMS, type CustomerStage } from '@/utils/enum-map'
import type { ContactItem, Customer360Profile } from '@/api/types/customers'
import type { LeadConvertResp } from '@/api/types/leads'
import type { PageResp } from '@/api/types/common'
import type { ApiError } from '@/api/http'
import { handleApiError } from '@/api/error-handler'
import { qk } from '@/query/keys'
import { staleTime } from '@/query/options'
import { useAuthStore } from '@/stores/auth'

type C360Tab = 'overview' | 'contacts' | 'products' | 'conversations' | 'activities' | 'insights'

const DEFAULT_TAB: C360Tab = 'overview'

/**
 * Customer360View 客户 360°（04 §1/§3）：
 * - 头部 = 返回入口 + 公司信息/标签 + 评分 + 语境化动作（lead 预览 → 加入 CRM；CRM 客户 →
 *   AI 分析 / 联系客户）+ 阶段 Stepper（可改阶段，走 05 stage 接口）；
 * - 页签懒加载：Overview / Contacts / Products / Conversations / Activities / AI Insights，
 *   lead 预览（inCrm=false）仅前三个页签；Quotes/Orders 按 features（D6）不渲染；
 * - AI 分析（头部与 Insights 页签共用 useCustomerAnalyze）→ 弹层轮询 → 终态 invalidate。
 */
const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const queryClient = useQueryClient()
const auth = useAuthStore()

const timezone = computed(() => auth.org?.timezone)
const entityId = computed(() => String(route.params.id ?? ''))

// ===== Profile（双数据源：customerId / leadId，04 §3.1） =====
const profileQuery = useQuery({
  queryKey: computed(() => qk.customer360.detail(entityId.value)),
  queryFn: () => getCustomer360(entityId.value),
  staleTime: staleTime.DETAIL,
})

const profile = computed<Customer360Profile | null>(() => profileQuery.data.value ?? null)
const isNotFound = computed(() => Boolean(profileQuery.error.value))

// ===== 返回目标：CRM 客户 ↔ 客户中心；lead 预览 ↔ 客户发现 =====
const backTo = ref<string | null>(null)
watch(
  profile,
  (p) => {
    if (p && backTo.value === null) backTo.value = p.inCrm ? '/crm' : '/lead-gen/leads'
  },
  { immediate: true },
)
const backPath = computed(() => backTo.value ?? '/crm')

// ===== 页签（lead 预览仅前三个；客户全量；Quotes/Orders D6 剔除） =====
const LEAD_TABS: C360Tab[] = ['overview', 'contacts', 'products']
const CRM_TABS: C360Tab[] = [...LEAD_TABS, 'conversations', 'activities', 'insights']

function queryTab(): C360Tab {
  const raw = route.query.tab
  const list: C360Tab[] = CRM_TABS
  return typeof raw === 'string' && (list as string[]).includes(raw)
    ? (raw as C360Tab)
    : DEFAULT_TAB
}

const activeTab = ref<C360Tab>(queryTab())

watch(
  [entityId, profile],
  () => {
    const list = profile.value?.inCrm ? CRM_TABS : LEAD_TABS
    if (!(list as string[]).includes(activeTab.value)) activeTab.value = DEFAULT_TAB
  },
  { immediate: true },
)

const tabVisible = (name: C360Tab) => (profile.value?.inCrm ? CRM_TABS : LEAD_TABS).includes(name)

// ===== 头部信息 =====
function countryLabel(code?: string): string {
  if (!code) return '—'
  const opt = ENUMS.country.find((o) => o.value === code)
  // 兼容历史小写值（如 'us'），labelKey 统一指向 enums.country.*
  return opt
    ? t(opt.labelKey)
    : t(ENUMS.country.find((o) => o.value === code.toUpperCase())?.labelKey ?? code)
}

const scoreTier = computed(() => {
  const score = profile.value?.score
  if (score === null || score === undefined) return 'none'
  if (score >= 80) return 'high'
  if (score >= 55) return 'mid'
  return 'low'
})

function goBack() {
  router.push(backPath.value)
}

// ===== 语境化动作 =====

/** lead 预览 → 加入 CRM（POST /leads/{id}/convert） */
const convertMutation = useMutation({
  mutationFn: () => convertLead(entityId.value),
  onError: (error: ApiError) => {
    handleApiError(error)
  },
  onSuccess: (resp: LeadConvertResp) => {
    ElMessage.success(t(resp.mapped ? 'c360.convertMapped' : 'c360.convertCreated'))
    // 双源缓存联动：360 详情 + 获客列表/计数 + CRM 列表
    void queryClient.invalidateQueries({ queryKey: qk.customer360.detail(entityId.value) })
    void queryClient.invalidateQueries({ queryKey: qk.leads.all })
    void queryClient.invalidateQueries({ queryKey: qk.leads.summary() })
    void queryClient.invalidateQueries({ queryKey: qk.customers.all })
  },
})

/** AI 分析（头部 CTA 与 Insights 页签共用）+ 联系客户（outreach 草稿） */
const analyze = useCustomerAnalyze(entityId)
const outreach = useOutreachDraft()

const primaryContactsQuery = useQuery<PageResp<ContactItem>>({
  queryKey: computed(() => qk.customer360.contacts(entityId.value, { page: 1, pageSize: 20 })),
  queryFn: () => getCustomerContacts(entityId.value, { page: 1, pageSize: 20 }),
  enabled: computed(() => Boolean(profile.value?.inCrm)),
  staleTime: staleTime.DETAIL,
})

const primaryContact = computed(() => {
  const list = primaryContactsQuery.data.value?.items ?? []
  return list.find((c) => c.isPrimary) ?? list[0] ?? null
})

async function contactCustomer() {
  const target = primaryContact.value
  if (!target) {
    ElMessage.warning(t('c360.noContactTarget'))
    return
  }
  void outreach.generate(target.contactId, 'cold_outreach')
}

// ===== 阶段 Stepper（04 §3.7：可改阶段；05 §3.2 流转规则） =====
const STAGE_ORDER: CustomerStage[] = ['new_lead', 'contacted', 'negotiation', 'cold']

interface StageStep {
  stage: CustomerStage
  index: number
  label: string
  color: string
  isCurrent: boolean
  isDone: boolean
}

type StageNode =
  { key: string; kind: 'line'; isDone: boolean } | { key: string; kind: 'step'; step: StageStep }

function stageLabel(stage: CustomerStage): string {
  const opt = ENUMS.customerStage.find((o) => o.value === stage)
  return opt ? t(opt.labelKey) : stage
}

const stageSteps = computed<StageStep[]>(() =>
  STAGE_ORDER.map((stage, index) => ({
    stage,
    index,
    label: stageLabel(stage),
    color: ENUMS.customerStage.find((o) => o.value === stage)?.color ?? 'var(--tp-text-tertiary)',
    isCurrent: profile.value?.stage === stage,
    isDone: index < STAGE_ORDER.indexOf(profile.value?.stage ?? 'new_lead'),
  })),
)

/** 扁平节点：step i>0 前插入连接线，连接线与按钮均为 flex 项（wrapper display:contents） */
const stageNodes = computed<StageNode[]>(() => {
  const nodes: StageNode[] = []
  for (const step of stageSteps.value) {
    if (step.index > 0) nodes.push({ key: `line-${step.stage}`, kind: 'line', isDone: step.isDone })
    nodes.push({ key: `step-${step.stage}`, kind: 'step', step })
  }
  return nodes
})

function canMoveTo(stage: CustomerStage): boolean {
  const current = STAGE_ORDER.indexOf(profile.value?.stage ?? 'new_lead')
  const target = STAGE_ORDER.indexOf(stage)
  return target > current || stage === 'contacted'
}

const stageDialogVisible = ref(false)
const stageTarget = ref<CustomerStage>('contacted')
const stageReason = ref('')

function clickStage(stage: CustomerStage) {
  if (profile.value?.stage === stage) return
  if (!canMoveTo(stage)) {
    ElMessage.warning(t('c360.stageChangeUnreachable'))
    return
  }
  stageTarget.value = stage
  stageReason.value = ''
  stageDialogVisible.value = true
}

const stageMutation = useMutation({
  mutationFn: () =>
    advanceCustomerStage(entityId.value, {
      stage: stageTarget.value,
      reason: stageReason.value.trim() || undefined,
    }),
  onError: (error: ApiError) => {
    handleApiError(error)
  },
  onSuccess: () => {
    ElMessage.success(t('c360.stageChanged'))
    stageDialogVisible.value = false
    void queryClient.invalidateQueries({ queryKey: qk.customer360.detail(entityId.value) })
    void queryClient.invalidateQueries({
      queryKey: qk.customer360.activities(entityId.value, undefined),
    })
  },
})

// ===== 路由守卫状态清理 =====
watch(entityId, () => {
  analyze.close()
  stageDialogVisible.value = false
})
</script>

<template>
  <div class="c360">
    <!-- 骨架 / 404 -->
    <el-skeleton v-if="profileQuery.isLoading.value" :rows="8" animated />
    <div v-else-if="isNotFound" class="c360__not-found">
      <EmptyState :title="t('c360.notFound')" :description="t('c360.notFoundDesc')">
        <el-button type="primary" @click="goBack">{{ t('common.back') }}</el-button>
      </EmptyState>
    </div>

    <template v-else-if="profile">
      <!-- 头部（04 FR-01） -->
      <section class="c360__hero">
        <div class="c360__back">
          <el-button link type="primary" size="small" @click="goBack">
            <el-icon><ArrowLeft /></el-icon>
            <span>{{ backPath === '/crm' ? t('menu.crm') : t('menu.leadDiscover') }}</span>
          </el-button>
        </div>

        <div class="c360__head">
          <div class="c360__head-left">
            <div class="c360__title">
              <h1 class="c360__company">{{ profile.companyName }}</h1>
              <el-tag
                v-if="!profile.inCrm"
                size="small"
                type="warning"
                effect="plain"
                class="c360__lead-tag"
              >
                {{ t('c360.leadPreview') }}
              </el-tag>
            </div>
            <div v-if="profile.industryTags?.length" class="c360__tags">
              <el-tag v-for="tag in profile.industryTags" :key="tag" size="small" effect="plain">
                {{ tag }}
              </el-tag>
            </div>

            <div class="c360__meta">
              <span class="c360__meta-item">{{ countryLabel(profile.country) }}</span>
              <a
                v-if="profile.website"
                class="c360__meta-item c360__link"
                :href="profile.website"
                target="_blank"
                rel="noopener noreferrer"
              >
                <el-icon><LinkIcon /></el-icon>
                {{ profile.website }}
              </a>
              <span v-else class="c360__meta-item c360__meta-item--muted">
                <el-icon><LinkIcon /></el-icon>
                —
              </span>
              <span v-if="profile.inCrm && profile.ownerName" class="c360__meta-item">
                <el-icon><UserFilled /></el-icon>
                {{ t('crm.owner') }}：{{ profile.ownerName }}
              </span>
            </div>
          </div>

          <!-- 评分（Score） -->
          <div class="c360__score" :class="`c360__score--${scoreTier}`">
            <span class="c360__score-value">
              {{ profile.score == null ? '—' : `${profile.score}%` }}
            </span>
            <span class="c360__score-label">{{ t('c360.scoreLabel') }}</span>
          </div>
        </div>

        <!-- 语境化动作 -->
        <div v-if="!profile.inCrm" class="c360__cta">
          <el-alert
            :title="t('c360.leadCrmHint')"
            type="info"
            :closable="false"
            show-icon
            class="c360__cta-hint"
          />
          <el-button
            type="primary"
            :loading="convertMutation.isPending.value"
            @click="convertMutation.mutate()"
          >
            {{ t('leadGen.addToCrm') }}
          </el-button>
        </div>
        <div v-else class="c360__cta">
          <el-button
            type="primary"
            plain
            :loading="analyze.running.value"
            @click="analyze.run('full')"
          >
            {{ t('c360.aiAnalyze') }}
          </el-button>
          <el-button type="primary" @click="contactCustomer">
            {{ t('c360.contactCustomer') }}
          </el-button>
        </div>

        <!-- 阶段 Stepper（仅 CRM 客户） -->
        <div v-if="profile.inCrm && profile.stage" class="c360__stage">
          <span class="c360__stage-label">{{ t('c360.stageLabel') }}</span>
          <div class="c360__stage-steps">
            <div v-for="node in stageNodes" :key="node.key" class="c360__stage-frag">
              <div
                v-if="node.kind === 'line'"
                class="c360__stage-line"
                :class="{ 'c360__stage-line--done': node.isDone }"
              />
              <button
                v-else
                type="button"
                class="c360__stage-step"
                :class="{
                  'c360__stage-step--current': node.step.isCurrent,
                  'c360__stage-step--clickable': canMoveTo(node.step.stage),
                }"
                @click="clickStage(node.step.stage)"
              >
                <span class="c360__stage-dot" :style="{ borderColor: node.step.color }" />
                <span class="c360__stage-name">{{ node.step.label }}</span>
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- 页签（懒加载；lead 预览仅前三个；Quotes/Orders 随 features D6 隐藏） -->
      <el-tabs v-model="activeTab" class="c360__tabs">
        <el-tab-pane v-if="tabVisible('overview')" name="overview" lazy>
          <template #label>{{ t('c360.tabOverview') }}</template>
          <OverviewPanel :key="entityId" :profile="profile" />
        </el-tab-pane>
        <el-tab-pane v-if="tabVisible('contacts')" name="contacts" lazy>
          <template #label>{{ t('c360.tabContacts') }}</template>
          <ContactsPanel :key="entityId" :entity-id="entityId" />
        </el-tab-pane>
        <el-tab-pane v-if="tabVisible('products')" name="products" lazy>
          <template #label>{{ t('c360.tabProducts') }}</template>
          <ProductsPanel :key="entityId" :entity-id="entityId" />
        </el-tab-pane>
        <el-tab-pane v-if="tabVisible('conversations')" name="conversations" lazy>
          <template #label>{{ t('c360.tabConversations') }}</template>
          <ConversationsPanel :key="entityId" :entity-id="entityId" :timezone="timezone" />
        </el-tab-pane>
        <el-tab-pane v-if="tabVisible('activities')" name="activities" lazy>
          <template #label>{{ t('c360.tabActivities') }}</template>
          <ActivitiesPanel :key="entityId" :entity-id="entityId" :timezone="timezone" />
        </el-tab-pane>
        <el-tab-pane v-if="tabVisible('insights')" name="insights" lazy>
          <template #label>{{ t('c360.tabInsights') }}</template>
          <InsightsPanel
            :key="entityId"
            :entity-id="entityId"
            :analyzing="analyze.running.value"
            :on-analyze="(scope) => analyze.run(scope)"
          />
        </el-tab-pane>
      </el-tabs>

      <!-- 阶段变更弹层（05 §3.2：正向推进 / 回退至 contacted） -->
      <el-dialog
        v-model="stageDialogVisible"
        :title="t('c360.stageChangeTitle')"
        width="420px"
        append-to-body
      >
        <el-form label-width="90px">
          <el-form-item :label="t('c360.stageChangeTarget')">
            <el-tag size="large" :type="stageTarget === 'cold' ? 'danger' : 'primary'">
              {{ stageLabel(stageTarget) }}
            </el-tag>
          </el-form-item>
          <el-form-item :label="t('c360.stageChangeReason')">
            <el-input
              v-model="stageReason"
              type="textarea"
              :rows="3"
              :placeholder="t('c360.stageChangeReasonPlaceholder')"
            />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="stageDialogVisible = false">{{ t('common.cancel') }}</el-button>
          <el-button
            type="primary"
            :loading="stageMutation.isPending.value"
            @click="stageMutation.mutate()"
          >
            {{ t('common.confirm') }}
          </el-button>
        </template>
      </el-dialog>

      <!-- AI 分析任务进度 + 联系客户草稿预览 -->
      <AnalyzeTaskDialog v-model="analyze.dialogVisible.value" :task="analyze.task.data.value" />
      <OutreachDraftDialog
        v-model="outreach.visible.value"
        :loading="outreach.loading.value"
        :draft="outreach.draft.value"
        @regenerate="outreach.regenerate"
        @update:model-value="outreach.close"
      />
    </template>
  </div>
</template>

<style scoped lang="scss">
.c360 {
  &__not-found {
    padding: 40px 0;
  }

  &__hero {
    padding: 16px 20px 0;
    margin-bottom: 16px;
    background: var(--tp-bg-card, #fff);
    border: 1px solid var(--tp-border-color);
    border-radius: 8px;
  }

  &__back {
    margin-bottom: 8px;
  }

  &__head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 20px;
  }

  &__head-left {
    flex: 1;
    min-width: 0;
  }

  &__title {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  &__company {
    margin: 0;
    font-size: 20px;
    font-weight: 700;
    color: var(--tp-text-primary);
    word-break: break-word;
  }

  &__tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }

  &__meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 16px;
    margin-top: 10px;
    font-size: 13px;
    color: var(--tp-text-secondary);
  }

  &__meta-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;

    .el-icon {
      color: var(--tp-text-tertiary);
    }
  }

  &__link {
    color: var(--tp-primary);
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    &:hover {
      text-decoration: underline;
    }
  }

  &__score {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    min-width: 92px;
    padding: 10px 14px;
    border-radius: 8px;
    background: var(--tp-bg-hover);
  }

  &__score-value {
    font-size: 24px;
    font-weight: 800;
    line-height: 1.2;
  }

  &__score-label {
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__score--high &__score-value {
    color: var(--ai-working);
  }

  &__score--mid &__score-value {
    color: var(--ai-waiting);
  }

  &__score--low &__score-value {
    color: var(--ai-risk);
  }

  &__score--none &__score-value {
    color: var(--tp-text-tertiary);
  }

  &__cta {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 14px;
  }

  &__cta-hint {
    flex: 1;
  }

  &__stage {
    display: flex;
    align-items: center;
    gap: 18px;
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px dashed var(--tp-border-color);
  }

  &__stage-label {
    flex-shrink: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--tp-text-tertiary);
  }

  &__stage-steps {
    display: flex;
    align-items: center;
    flex: 1;
  }

  &__stage-frag {
    display: contents;
  }

  &__stage-step {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border: none;
    background: transparent;
    cursor: default;
    font: inherit;
    color: var(--tp-text-secondary);
    border-radius: 6px;

    &--current {
      font-weight: 700;
      color: var(--tp-text-primary);
    }

    &--clickable {
      cursor: pointer;

      &:hover {
        background: var(--tp-bg-hover);
      }
    }
  }

  &__stage-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 2px solid;
    background: var(--tp-bg-card, #fff);
  }

  &__stage-name {
    white-space: nowrap;
  }

  &__stage-line {
    flex: 1;
    min-width: 16px;
    height: 2px;
    background: var(--tp-border-color);
    margin: 0 4px;

    &--done {
      background: var(--tp-primary);
    }
  }
}
</style>
