<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import type { Customer360Profile, CustomerType } from '@/api/types/customers'
import { ENUMS } from '@/utils/enum-map'

/**
 * OverviewPanel Overview 页签（04 §1.2 / FR-03/04）：
 * 客户信息（规模/成立时间/类型/主营产品）+ 产品匹配进度列表（数据来自 GET /customers/{id} overview）。
 */
const props = defineProps<{ profile: Customer360Profile }>()

const { t } = useI18n()

const CUSTOMER_TYPE: Record<string, string> = ENUMS.customerType.reduce<Record<string, string>>(
  (acc, o) => {
    acc[o.value] = t(o.labelKey)
    return acc
  },
  {},
)

const rows = computed(() => {
  const overview = props.profile.overview
  return [
    {
      key: 'size',
      label: t('c360.overviewSize'),
      value: overview.companySize ? String(overview.companySize) : '—',
    },
    {
      key: 'founded',
      label: t('c360.overviewFounded'),
      value: overview.foundedYear ? String(overview.foundedYear) : '—',
    },
    {
      key: 'type',
      label: t('c360.overviewType'),
      value: typeLabel(overview.customerType),
    },
  ]
})

function typeLabel(type?: CustomerType | null): string {
  if (!type) return '—'
  return CUSTOMER_TYPE[type] ?? type
}

const matches = computed(() => props.profile.overview.productMatches ?? [])
</script>

<template>
  <div class="overview-panel">
    <el-card shadow="never" class="overview-panel__info">
      <template #header>
        <span class="overview-panel__card-title">{{ t('c360.overviewInfoTitle') }}</span>
      </template>
      <dl class="overview-panel__rows">
        <div v-for="row in rows" :key="row.key" class="overview-panel__row">
          <dt>{{ row.label }}</dt>
          <dd>{{ row.value }}</dd>
        </div>
        <div class="overview-panel__row">
          <dt>{{ t('c360.overviewMainProducts') }}</dt>
          <dd>
            <div v-if="profile.overview.mainProducts?.length" class="overview-panel__chips">
              <el-tag
                v-for="(p, i) in profile.overview.mainProducts"
                :key="i"
                size="small"
                effect="plain"
              >
                {{ p }}
              </el-tag>
            </div>
            <span v-else>—</span>
          </dd>
        </div>
      </dl>
    </el-card>

    <el-card shadow="never" class="overview-panel__match">
      <template #header>
        <span class="overview-panel__card-title">{{ t('c360.overviewMatchTitle') }}</span>
      </template>
      <div v-if="matches.length" class="overview-panel__list">
        <el-tooltip
          v-for="m in matches"
          :key="m.productId"
          placement="top"
          :disabled="!m.reasons?.length"
        >
          <template #content>
            <div v-if="m.reasons?.length">
              <p v-for="(r, i) in m.reasons" :key="i" class="overview-panel__reason">
                {{ r.text }}
                <span v-if="r.evidence" class="overview-panel__reason-meta">{{ r.evidence }}</span>
              </p>
            </div>
          </template>
          <div class="overview-panel__match-row">
            <span class="overview-panel__match-name">{{ m.productName }}</span>
            <div class="overview-panel__bar">
              <div
                class="overview-panel__bar-fill"
                :style="{ width: `${Math.max(0, Math.min(100, m.matchPct))}%` }"
              />
            </div>
            <span class="overview-panel__match-pct">{{ m.matchPct }}%</span>
          </div>
        </el-tooltip>
      </div>
      <p v-else class="overview-panel__empty">{{ t('c360.overviewNoMatch') }}</p>
    </el-card>
  </div>
</template>

<style scoped lang="scss">
.overview-panel {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;

  &__card-title {
    font-weight: 600;
  }

  &__rows {
    margin: 0;
  }

  &__row {
    display: flex;
    gap: 16px;
    padding: 7px 0;
    border-bottom: 1px dashed var(--tp-border-color);

    &:last-child {
      border-bottom: none;
    }

    dt {
      flex-shrink: 0;
      width: 96px;
      color: var(--tp-text-tertiary);
    }

    dd {
      margin: 0;
      color: var(--tp-text-primary);
      word-break: break-word;
    }
  }

  &__chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  &__list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  &__match-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  &__match-name {
    flex-shrink: 0;
    width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--tp-text-primary);
  }

  &__bar {
    flex: 1;
    height: 8px;
    border-radius: 4px;
    background: var(--tp-bg-hover);
    overflow: hidden;
  }

  &__bar-fill {
    height: 100%;
    border-radius: 4px;
    background: linear-gradient(90deg, var(--ai-waiting), var(--ai-working));
  }

  &__match-pct {
    flex-shrink: 0;
    min-width: 40px;
    text-align: right;
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__empty {
    margin: 0;
    color: var(--tp-text-tertiary);
  }

  &__reason {
    margin: 0 0 6px;
    line-height: 1.5;
  }

  &__reason-meta {
    display: block;
    color: var(--tp-text-tertiary);
  }
}
</style>
