<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import type { AiContributionResp, AnalyticsMetric } from '@/api/types/analytics'

/**
 * AI 贡献卡片（15 §1.3 / §3.3）。
 * savedHours 为估算指标：卡片标注「估算」并展示接口下发的 caliberNote（15 §4 红线）。
 */
const props = withDefaults(
  defineProps<{ contribution?: AiContributionResp; loading?: boolean }>(),
  { contribution: undefined, loading: false },
)

const emit = defineEmits<{ drilldown: [metric: AnalyticsMetric] }>()

const { t } = useI18n()

const cards = computed(() => {
  const data = props.contribution
  return [
    {
      metric: 'found_customers' as AnalyticsMetric,
      labelKey: 'dataCenter.metric.foundCustomers',
      value: data?.foundCustomers ?? 0,
      unit: '',
      estimated: false,
    },
    {
      metric: 'replied_emails' as AnalyticsMetric,
      labelKey: 'dataCenter.metric.repliedEmails',
      value: data?.repliedEmails ?? 0,
      unit: '',
      estimated: false,
    },
    {
      metric: 'saved_hours' as AnalyticsMetric,
      labelKey: 'dataCenter.metric.savedHours',
      value: data?.savedHours ?? 0,
      unit: t('dataCenter.hoursUnit'),
      estimated: true,
    },
    {
      metric: 'promoted_inquiries' as AnalyticsMetric,
      labelKey: 'dataCenter.metric.promotedInquiries',
      value: data?.promotedInquiries ?? 0,
      unit: '',
      estimated: false,
    },
  ]
})
</script>

<template>
  <div class="contribution" v-loading="props.loading">
    <div class="contribution__grid">
      <el-card
        v-for="card in cards"
        :key="card.metric"
        shadow="never"
        class="contribution__card"
        role="button"
        :title="t('dataCenter.drilldownHint')"
        @click="emit('drilldown', card.metric)"
      >
        <div class="contribution__head">
          <span class="contribution__label">{{ t(card.labelKey) }}</span>
          <el-tag v-if="card.estimated" size="small" type="warning" effect="plain">
            {{ t('dataCenter.estimatedTag') }}
          </el-tag>
        </div>
        <div class="contribution__value">
          <strong>{{ card.value }}</strong>
          <span v-if="card.unit" class="contribution__unit">{{ card.unit }}</span>
        </div>
      </el-card>
    </div>

    <!-- 估算口径说明（15 §3.3 caliberNote 原样展示） -->
    <p v-if="props.contribution" class="contribution__note">
      {{ t('dataCenter.caliberLabel') }}{{ props.contribution.caliberNote }}
    </p>
  </div>
</template>

<style scoped lang="scss">
.contribution {
  &__grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
  }

  &__card {
    cursor: pointer;
    transition: box-shadow 0.2s;

    &:hover {
      box-shadow: 0 2px 12px rgb(0 0 0 / 8%);
    }

    :deep(.el-card__body) {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
  }

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  &__label {
    font-size: 13px;
    color: var(--tp-text-tertiary);
  }

  &__value {
    display: flex;
    align-items: baseline;
    gap: 4px;

    strong {
      font-size: 26px;
      font-weight: 600;
      color: var(--tp-text-primary);
    }
  }

  &__unit {
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__note {
    margin: 10px 0 0;
    font-size: 12px;
    line-height: 1.6;
    color: var(--tp-text-tertiary);
  }
}
</style>
