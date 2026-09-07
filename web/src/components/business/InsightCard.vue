<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import CitationPopover from './CitationPopover.vue'
import type { Insight, InsightCitation, InsightCitationGroup } from '@/api/types/insight'
import { DEFAULT_TIMEZONE, formatInOrgTz } from '@/utils/date'

/**
 * InsightCard AI 产出证据链展示（04 §2.1，全应用最核心组件）：
 * 凡 AI 生成结论（评分/概率/建议/风险）一律呈现 { value, confidence, reasons[], citations[], estimated?, generatedAt }。
 * - confidence 视觉分级：≥0.8 实色 / 0.5~0.8 半透明 / <0.5 灰 + 「低置信」角标；
 * - citations 可点击 → CitationPopover 溯源（docName/分类/上传人；已删文档标记禁跳）；
 * - estimated: true 强制角标（业务报告约束）。
 */
const props = withDefaults(
  defineProps<{
    insight: Insight<number> | null | undefined
    /** 结论语义前缀，如「采购概率」；缺省仅展示数值 */
    valueLabel?: string
    /** 数值单位（Insight Schema value 为百分比 0~100，默认 %） */
    valueSuffix?: string
    /** 展示时区（企业时区，缺省 Asia/Shanghai） */
    timezone?: string
  }>(),
  { insight: null, valueLabel: undefined, valueSuffix: '%', timezone: DEFAULT_TIMEZONE },
)

const { t } = useI18n()

const confidencePct = computed(() => Math.round((props.insight?.confidence ?? 0) * 100))

/** confidence 三档视觉分级（04 §2.1） */
const confidenceTier = computed<'high' | 'mid' | 'low'>(() => {
  const confidence = props.insight?.confidence ?? 0
  if (confidence >= 0.8) return 'high'
  if (confidence >= 0.5) return 'mid'
  return 'low'
})

const isLowConfidence = computed(() => confidenceTier.value === 'low')

const displayValue = computed(() => {
  const value = props.insight?.value
  if (value === undefined || value === null) return ''
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
})

/** 相同 docId 的引用聚合成单 chip（chunk 多命中显示 ×N） */
const citationGroups = computed<InsightCitationGroup[]>(() => {
  const groups = new Map<string, InsightCitation>()
  const order: string[] = []
  for (const citation of props.insight?.citations ?? []) {
    const key = citation.docId
    if (!groups.has(key)) {
      groups.set(key, { ...citation })
      order.push(key)
    }
  }
  return order.map((key) => ({ ...groups.get(key)!, count: countByDocId(key) }))
})

function countByDocId(docId: string): number {
  return (props.insight?.citations ?? []).filter((c) => c.docId === docId).length
}

const analyzedAt = computed(() =>
  props.insight?.generatedAt
    ? formatInOrgTz(props.insight.generatedAt, props.timezone, 'YYYY-MM-DD HH:mm')
    : '',
)
</script>

<template>
  <div v-if="insight" class="insight-card" data-testid="insight-card">
    <!-- 结论值 + 低置信角标 -->
    <div class="insight-card__head">
      <div class="insight-card__value" :class="{ 'insight-card__value--low': isLowConfidence }">
        <template v-if="props.valueLabel">
          <span class="insight-card__value-label">{{ props.valueLabel }}</span>
        </template>
        <strong class="insight-card__value-num">{{ displayValue }}</strong>
        <span v-if="props.valueSuffix" class="insight-card__value-suffix">{{
          props.valueSuffix
        }}</span>
      </div>
      <span
        v-if="isLowConfidence"
        class="insight-card__low-badge"
        :title="t('insight.lowConfidenceTip')"
      >
        {{ t('insight.lowConfidence') }}
      </span>
    </div>

    <!-- 置信度进度（tier 三档视觉分级） -->
    <div class="insight-card__conf">
      <span class="insight-card__conf-label">{{ t('insight.confidence') }}</span>
      <div class="insight-card__conf-track">
        <div
          class="insight-card__conf-fill"
          :class="`insight-card__conf-fill--${confidenceTier}`"
          :data-tier="confidenceTier"
          :style="{ width: `${confidencePct}%` }"
        />
      </div>
      <span class="insight-card__conf-pct">{{ confidencePct }}%</span>
    </div>

    <!-- 判断原因（逐条证据链） -->
    <template v-if="insight.reasons?.length">
      <div class="insight-card__section">{{ t('insight.reasons') }}</div>
      <ul class="insight-card__reasons">
        <li v-for="(reason, i) in insight.reasons" :key="i" class="insight-card__reason">
          <span class="insight-card__reason-text">{{ reason.text }}</span>
          <span v-if="reason.evidence || reason.source" class="insight-card__reason-meta">
            <span v-if="reason.evidence">{{ reason.evidence }}</span>
            <span v-if="reason.source" class="insight-card__reason-source">
              {{ t('insight.source') }}：{{ reason.source }}
            </span>
          </span>
        </li>
      </ul>
    </template>
    <p v-else class="insight-card__none">{{ t('insight.noReasons') }}</p>

    <!-- 知识引用（citations 可点击 → CitationPopover） -->
    <template v-if="citationGroups.length">
      <div class="insight-card__section">{{ t('insight.citations') }}</div>
      <div class="insight-card__citations">
        <CitationPopover
          v-for="group in citationGroups"
          :key="group.docId"
          :citation="{ docId: group.docId, docName: group.docName, chunkId: group.chunkId }"
        >
          <span class="insight-card__cite">
            <span class="insight-card__cite-name">{{ group.docName }}</span>
            <span v-if="group.count > 1" class="insight-card__cite-count">×{{ group.count }}</span>
          </span>
        </CitationPopover>
      </div>
    </template>

    <!-- 生成时间 + estimated 强制角标 -->
    <div class="insight-card__footer">
      <span v-if="analyzedAt" class="insight-card__analyzed">
        {{ t('insight.analyzedAt') }} {{ analyzedAt }}
      </span>
      <span
        v-if="insight.estimated"
        class="insight-card__estimated"
        :title="t('insight.estimatedTip')"
      >
        {{ t('insight.estimated') }}
      </span>
    </div>
  </div>
</template>

<style scoped lang="scss">
.insight-card {
  font-size: 13px;
  color: var(--tp-text-primary);

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
  }

  &__value {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    min-width: 0;

    &--low .insight-card__value-num {
      color: var(--tp-text-tertiary);
    }
  }

  &__value-label {
    color: var(--tp-text-secondary);
  }

  &__value-num {
    font-size: 16px;
    font-weight: 700;
    line-height: 1.2;
  }

  &__value-suffix {
    font-size: 13px;
    color: var(--tp-text-secondary);
  }

  &__low-badge {
    flex-shrink: 0;
    padding: 0 6px;
    line-height: 18px;
    font-size: 12px;
    color: var(--tp-text-secondary);
    background: var(--tp-bg-hover);
    border: 1px solid var(--tp-border-color);
    border-radius: 4px;
  }

  &__conf {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }

  &__conf-label {
    flex-shrink: 0;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__conf-track {
    position: relative;
    flex: 1;
    height: 6px;
    border-radius: 3px;
    background: var(--tp-bg-hover);
    overflow: hidden;
  }

  &__conf-fill {
    height: 100%;
    border-radius: 3px;
    transition: width 0.2s ease;

    // ≥0.8 实色
    &--high {
      background: var(--ai-working);
    }

    // 0.5~0.8 半透明
    &--mid {
      background: var(--ai-waiting);
      opacity: 0.55;
    }

    // <0.5 灰
    &--low {
      background: var(--ai-idle);
    }
  }

  &__conf-pct {
    flex-shrink: 0;
    min-width: 36px;
    text-align: right;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__section {
    margin: 10px 0 6px;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__reasons {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  &__reason {
    margin-bottom: 8px;
    line-height: 1.5;

    &:last-child {
      margin-bottom: 0;
    }
  }

  &__reason-text {
    display: block;
    font-weight: 500;
  }

  &__reason-meta {
    display: block;
    font-size: 12px;
    color: var(--tp-text-tertiary);
    overflow-wrap: anywhere;
  }

  &__reason-source {
    color: var(--tp-text-secondary);
  }

  &__none {
    margin: 6px 0 0;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__citations {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  &__cite {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    padding: 2px 8px;
    line-height: 20px;
    font-size: 12px;
    color: var(--tp-primary);
    background: var(--tp-bg-hover);
    border-radius: 4px;

    &:hover {
      text-decoration: underline;
    }
  }

  &__cite-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__cite-count {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--tp-text-secondary);
  }

  &__footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-top: 10px;
  }

  &__analyzed {
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__estimated {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    font-weight: 600;
    color: var(--ai-waiting);

    &::before {
      content: '!';
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 13px;
      height: 13px;
      border: 1px solid currentcolor;
      border-radius: 50%;
      font-size: 10px;
    }
  }
}
</style>
