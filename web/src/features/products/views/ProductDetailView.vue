<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'
import { ArrowLeft } from '@element-plus/icons-vue'

import AiStatusTag from '@/components/business/AiStatusTag.vue'
import EmptyState from '@/components/business/EmptyState.vue'
import TaskProgressCard from '@/components/business/TaskProgressCard.vue'
import ProductFormDialog from '../components/ProductFormDialog.vue'
import ProductDocumentsPanel from '../components/ProductDocumentsPanel.vue'
import ProductKnowledgePanel from '../components/ProductKnowledgePanel.vue'
import { useProductKnowledge } from '../composables/useProductKnowledge'
import { confirmProductKnowledge, getProduct } from '@/api/resources/products'
import { handleApiError } from '@/api/error-handler'
import { usePermission } from '@/composables/usePermission'
import { qk } from '@/query/keys'
import { formatInOrgTz } from '@/utils/date'
import { formatMoney } from '@/utils/format'
import type { ProductKnowledgeSource } from '@/api/types/products'

defineOptions({ name: 'ProductDetailView' })

/**
 * 08 产品详情（FR-04~07，08 §1.2~§1.6）：
 * 5 页签 Overview / Specifications / Pricing / Documents / AI Knowledge，tab 状态同步到 URL（可分享/刷新保持）；
 * AI 分析（不落库，弹层预览 outputs）与 AI 生成（落 draft 待人工确认）统一走产品知识任务。
 */
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()
const { canManage } = usePermission()

const TABS = ['overview', 'specifications', 'pricing', 'documents', 'knowledge'] as const
type TabKey = (typeof TABS)[number]

const productId = computed(() => String(route.params.id ?? ''))

const activeTab = ref<TabKey>(
  TABS.includes(route.query.tab as TabKey) ? (route.query.tab as TabKey) : 'overview',
)

watch(
  () => route.query.tab,
  (tab) => {
    if (TABS.includes(tab as TabKey)) activeTab.value = tab as TabKey
  },
)

function onTabChange(key: string | number) {
  void router.replace({ query: { ...route.query, tab: String(key) } })
}

const detailQuery = useQuery({
  queryKey: computed(() => qk.products.detail(productId.value)),
  queryFn: () => getProduct(productId.value),
  enabled: computed(() => Boolean(productId.value)),
  retry: 1,
  // 资料归档索引异步：存在未索引资料时轮询至终态（08 §4）
  refetchInterval: (query) => {
    const data = query.state.data
    return data?.documents.some((doc) => !doc.indexed) ? 3000 : false
  },
})

const detail = computed(() => detailQuery.data.value ?? null)
const isError = computed(() => detailQuery.isError.value)

const formVisible = ref(false)
const confirming = ref(false)

const ai = useProductKnowledge(productId)
const aiTask = computed(() => ai.task.data.value ?? null)

function onEdit() {
  formVisible.value = true
}

function onSaved() {
  void queryClient.invalidateQueries({ queryKey: qk.products.detail(productId.value) })
  void queryClient.invalidateQueries({ queryKey: qk.products.all })
}

function onGenerate(sources: ProductKnowledgeSource[]) {
  void ai.run('generate', sources)
}

function onAnalyze(sources: ProductKnowledgeSource[]) {
  void ai.run('analyze', sources)
}

async function onConfirm() {
  confirming.value = true
  try {
    await confirmProductKnowledge(productId.value)
    ElMessage.success(t('products.knowledgeConfirmed'))
    void queryClient.invalidateQueries({ queryKey: qk.products.detail(productId.value) })
  } catch (error) {
    handleApiError(error)
  } finally {
    confirming.value = false
  }
}
</script>

<template>
  <div class="product-detail">
    <el-skeleton v-if="detailQuery.isPending.value" :rows="6" animated />

    <EmptyState v-else-if="isError || !detail" :description="t('products.notFound')">
      <el-button @click="router.push({ name: 'products' })">{{ t('products.back') }}</el-button>
    </EmptyState>

    <template v-else>
      <header class="product-detail__header">
        <div class="product-detail__identity">
          <el-button link @click="router.push({ name: 'products' })">
            <el-icon><ArrowLeft /></el-icon>{{ t('products.back') }}
          </el-button>
          <img v-if="detail.image" class="product-detail__image" :src="detail.image" alt="" />
          <div>
            <h3 class="product-detail__name">{{ detail.name }}</h3>
            <div class="product-detail__sku">
              <span>SKU: {{ detail.sku }}</span>
              <AiStatusTag group="productStatus" :value="detail.status" />
              <span v-if="detail.category">{{ detail.category }}</span>
            </div>
          </div>
        </div>
        <div class="product-detail__actions">
          <el-button type="primary" @click="onEdit">{{ t('products.edit') }}</el-button>
        </div>
      </header>

      <el-tabs :model-value="activeTab" @tab-change="onTabChange">
        <!-- Overview（08 §1.2） -->
        <el-tab-pane :label="t('products.tabOverview')" name="overview">
          <el-descriptions :column="3" border>
            <el-descriptions-item :label="t('products.overviewCategory')">
              {{ detail.category ?? '—' }}
            </el-descriptions-item>
            <el-descriptions-item :label="t('products.overviewMoq')">
              {{ detail.moq }} {{ detail.moqUnit }}
            </el-descriptions-item>
            <el-descriptions-item :label="t('products.overviewLeadTime')">
              {{ detail.leadTimeDays }} {{ t('products.days') }}
            </el-descriptions-item>
            <el-descriptions-item :label="t('products.overviewMaterial')">
              {{ detail.material ?? '—' }}
            </el-descriptions-item>
          </el-descriptions>
          <div class="product-detail__block">
            <h4 class="product-detail__block-title">{{ t('products.overviewDescription') }}</h4>
            <p class="product-detail__description">{{ detail.description ?? '—' }}</p>
          </div>
        </el-tab-pane>

        <!-- Specifications（08 §1.3） -->
        <el-tab-pane :label="t('products.tabSpecifications')" name="specifications">
          <el-table :data="detail.specifications" row-key="name" stripe>
            <el-table-column prop="name" :label="t('products.specName')" min-width="180" />
            <el-table-column prop="value" :label="t('products.specValue')" min-width="220" />
            <el-table-column prop="unit" :label="t('products.specUnit')" width="120">
              <template #default="{ row }">{{ row.unit ?? '—' }}</template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <!-- Pricing（08 §1.4：结构化字段，AI 不改价） -->
        <el-tab-pane :label="t('products.tabPricing')" name="pricing">
          <el-alert :title="t('products.pricingHint')" type="info" :closable="false" show-icon />
          <el-descriptions :column="3" border class="product-detail__block">
            <el-descriptions-item :label="t('products.costPrice')">
              {{ formatMoney(detail.costPrice, detail.currency) }}
            </el-descriptions-item>
            <el-descriptions-item :label="t('products.suggestedPrice')">
              {{ formatMoney(detail.suggestedPrice, detail.currency) }}
            </el-descriptions-item>
            <el-descriptions-item :label="t('products.currency')">{{
              detail.currency
            }}</el-descriptions-item>
          </el-descriptions>
          <el-table :data="detail.priceTiers" row-key="minQty" stripe>
            <el-table-column prop="minQty" :label="t('products.priceTierQty')" min-width="160" />
            <el-table-column :label="t('products.priceTierPrice')" min-width="180">
              <template #default="{ row }">
                {{ formatMoney(row.unitPrice, detail.currency) }}
              </template>
            </el-table-column>
            <template #empty>{{ t('products.tierEmpty') }}</template>
          </el-table>
        </el-tab-pane>

        <!-- Documents（08 §1.5） -->
        <el-tab-pane :label="t('products.tabDocuments')" name="documents">
          <ProductDocumentsPanel
            :product-id="detail.productId"
            :documents="detail.documents"
            :can-manage="canManage"
            @changed="onSaved"
          />
        </el-tab-pane>

        <!-- AI Knowledge（08 §1.6 / §3.2） -->
        <el-tab-pane :label="t('products.tabKnowledge')" name="knowledge">
          <ProductKnowledgePanel
            :knowledge="detail.knowledge"
            :can-manage="canManage"
            :running="ai.running.value"
            @generate="onGenerate"
            @analyze="onAnalyze"
            @confirm="onConfirm"
          />
        </el-tab-pane>
      </el-tabs>

      <div class="product-detail__footer">
        {{ t('products.updatedAt') }}：{{ formatInOrgTz(detail.updatedAt) }}
      </div>
    </template>

    <ProductFormDialog v-model="formVisible" mode="edit" :product="detail" @saved="onSaved" />

    <!-- AI 任务进度 + analyze 预览（不落库，仅展示 outputs） -->
    <el-dialog
      :model-value="ai.dialogVisible.value"
      :title="
        ai.mode.value === 'analyze' ? t('products.analyzeTitle') : t('products.generateTitle')
      "
      width="640px"
      :close-on-click-modal="false"
      append-to-body
      @close="ai.close()"
    >
      <el-skeleton v-if="!aiTask" :rows="3" animated />
      <TaskProgressCard
        v-else
        :title="aiTask.title"
        :goal="aiTask.goal"
        :status="aiTask.status"
        :progress-pct="aiTask.progressPct"
        :current-step="aiTask.currentStep"
        :error="aiTask.error"
      />

      <div v-if="ai.mode.value === 'analyze' && ai.preview.value" class="product-detail__preview">
        <h4 class="product-detail__block-title">{{ t('products.knowledgeAdvantages') }}</h4>
        <ul>
          <li v-for="(item, index) in ai.preview.value.advantages" :key="`p-adv-${index}`">
            {{ item }}
          </li>
        </ul>
        <h4 class="product-detail__block-title">{{ t('products.knowledgeScenarios') }}</h4>
        <ul>
          <li v-for="(item, index) in ai.preview.value.scenarios" :key="`p-sc-${index}`">
            {{ item }}
          </li>
        </ul>
      </div>

      <template #footer>
        <el-button @click="ai.close()">{{ t('common.close') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped lang="scss">
.product-detail {
  &__header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: calc(var(--tp-spacing-base) * 3);
  }

  &__identity {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  &__image {
    width: 48px;
    height: 48px;
    border-radius: var(--tp-border-radius-base);
    object-fit: cover;
  }

  &__name {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__sku {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 4px;
    font-size: 13px;
    color: var(--tp-text-tertiary);
  }

  &__block {
    margin-top: 16px;
  }

  &__block-title {
    margin: 0 0 8px;
    font-size: 14px;
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__description {
    margin: 0;
    color: var(--tp-text-secondary);
    line-height: 1.7;
    white-space: pre-wrap;
  }

  &__preview {
    margin-top: 16px;
    padding-top: 12px;
    border-top: 1px solid var(--tp-border-color);
    color: var(--tp-text-secondary);
  }

  &__footer {
    margin-top: calc(var(--tp-spacing-base) * 3);
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }
}
</style>
