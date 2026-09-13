<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import AiStatusTag from '@/components/business/AiStatusTag.vue'
import EmptyState from '@/components/business/EmptyState.vue'
import { formatInOrgTz } from '@/utils/date'
import type { ProductKnowledge, ProductKnowledgeSource } from '@/api/types/products'

/**
 * ProductKnowledgePanel AI 知识页签（FR-07，08 §1.6/§3.2）：
 * 四类条目（优势 / FAQ / 场景 / 话术）+ 引用溯源 + status（draft 待确认 → approved 已启用）；
 * 生成/分析动作上抛父级（统一走产品知识异步任务）；确认启用仅经理/管理员。
 */
const props = withDefaults(
  defineProps<{
    knowledge: ProductKnowledge | null
    canManage?: boolean
    running?: boolean
  }>(),
  { canManage: false, running: false },
)

const emit = defineEmits<{
  generate: [sources: ProductKnowledgeSource[]]
  analyze: [sources: ProductKnowledgeSource[]]
  confirm: []
}>()

const { t } = useI18n()

/** 生成输入（08 §3.2）：结构化规格 / 价格结构（不含成本）/ 已索引资料 */
const ALL_SOURCES: ProductKnowledgeSource[] = ['specifications', 'pricing', 'documents']
const selectedSources = ref<ProductKnowledgeSource[]>([...ALL_SOURCES])

const sourceLabels: Record<ProductKnowledgeSource, string> = {
  specifications: 'products.sourceSpecifications',
  pricing: 'products.sourcePricing',
  documents: 'products.sourceDocuments',
}

const citationLabel = computed(() =>
  (props.knowledge?.citations ?? [])
    .map((c) => c.docName ?? c.docId)
    .filter(Boolean)
    .join('、'),
)
</script>

<template>
  <div class="product-knowledge">
    <div class="product-knowledge__toolbar">
      <div class="product-knowledge__sources">
        <span class="product-knowledge__label">{{ t('products.knowledgeSources') }}</span>
        <el-checkbox-group v-model="selectedSources">
          <el-checkbox v-for="source in ALL_SOURCES" :key="source" :value="source">
            {{ t(sourceLabels[source]) }}
          </el-checkbox>
        </el-checkbox-group>
      </div>
      <div class="product-knowledge__actions">
        <el-button :loading="props.running" @click="emit('analyze', selectedSources)">
          {{ t('products.knowledgeAnalyze') }}
        </el-button>
        <el-button
          type="primary"
          :loading="props.running"
          @click="emit('generate', selectedSources)"
        >
          {{
            props.knowledge ? t('products.knowledgeRegenerate') : t('products.knowledgeGenerate')
          }}
        </el-button>
        <el-button
          v-if="props.canManage && props.knowledge?.status === 'draft'"
          type="success"
          @click="emit('confirm')"
        >
          {{ t('products.knowledgeConfirm') }}
        </el-button>
      </div>
    </div>

    <el-alert :title="t('products.knowledgeHint')" type="info" :closable="false" show-icon />

    <EmptyState v-if="!props.knowledge" :description="t('products.knowledgeEmpty')" />

    <template v-else>
      <div class="product-knowledge__meta">
        <AiStatusTag group="productKnowledgeStatus" :value="props.knowledge.status" />
        <span v-if="props.knowledge.generatedAt" class="product-knowledge__meta-item">
          {{ t('products.knowledgeGeneratedAt') }}：
          {{ formatInOrgTz(props.knowledge.generatedAt) }}
        </span>
        <span v-if="props.knowledge.confirmedBy" class="product-knowledge__meta-item">
          {{ t('products.knowledgeConfirmedBy') }}：{{ props.knowledge.confirmedBy }}
        </span>
      </div>

      <section class="product-knowledge__section">
        <h4 class="product-knowledge__section-title">{{ t('products.knowledgeAdvantages') }}</h4>
        <ul class="product-knowledge__list">
          <li v-for="(item, index) in props.knowledge.advantages" :key="`adv-${index}`">
            {{ item }}
          </li>
        </ul>
      </section>

      <section class="product-knowledge__section">
        <h4 class="product-knowledge__section-title">{{ t('products.knowledgeFaqs') }}</h4>
        <div
          v-for="(faq, index) in props.knowledge.faqs"
          :key="`faq-${index}`"
          class="product-knowledge__faq"
        >
          <p class="product-knowledge__faq-q">Q: {{ faq.question }}</p>
          <p class="product-knowledge__faq-a">A: {{ faq.answer }}</p>
        </div>
      </section>

      <section class="product-knowledge__section">
        <h4 class="product-knowledge__section-title">{{ t('products.knowledgeScenarios') }}</h4>
        <ul class="product-knowledge__list">
          <li v-for="(item, index) in props.knowledge.scenarios" :key="`sc-${index}`">
            {{ item }}
          </li>
        </ul>
      </section>

      <section class="product-knowledge__section">
        <h4 class="product-knowledge__section-title">{{ t('products.knowledgeScripts') }}</h4>
        <p
          v-for="(item, index) in props.knowledge.salesScripts"
          :key="`script-${index}`"
          class="product-knowledge__script"
        >
          {{ item }}
        </p>
      </section>

      <p v-if="citationLabel" class="product-knowledge__citations">
        {{ t('products.citations') }}：{{ citationLabel }}
      </p>
    </template>
  </div>
</template>

<style scoped lang="scss">
.product-knowledge {
  &__toolbar {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }

  &__sources {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  &__label {
    font-size: 13px;
    color: var(--tp-text-tertiary);
  }

  &__actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  &__meta {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
    margin: 12px 0;
  }

  &__meta-item {
    font-size: 13px;
    color: var(--tp-text-secondary);
  }

  &__section {
    margin-bottom: 16px;
  }

  &__section-title {
    margin: 0 0 8px;
    font-size: 14px;
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__list {
    margin: 0;
    padding-left: 18px;
    color: var(--tp-text-secondary);
    line-height: 1.7;
  }

  &__faq {
    margin-bottom: 8px;
    padding: 8px 12px;
    background: var(--tp-bg-hover);
    border-radius: var(--tp-border-radius-base);
  }

  &__faq-q {
    margin: 0;
    font-weight: 500;
    color: var(--tp-text-primary);
  }

  &__faq-a {
    margin: 4px 0 0;
    color: var(--tp-text-secondary);
  }

  &__script {
    margin: 0 0 8px;
    padding: 8px 12px;
    background: var(--tp-bg-hover);
    border-radius: var(--tp-border-radius-base);
    color: var(--tp-text-secondary);
    line-height: 1.6;
  }

  &__citations {
    margin: 0;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }
}
</style>
