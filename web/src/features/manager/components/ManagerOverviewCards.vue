<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import type { ManagerOverview } from '@/api/types/manager'

/**
 * 13 §1.1 今日经营概览：四项核心指标卡（与 15 数据中心同源，点击不下钻）。
 * 指标缺失（loading / 接口未返回）统一渲染骨架，不显示 0（避免误读为真实为零）。
 */
const props = withDefaults(
  defineProps<{
    overview: ManagerOverview | null
    loading?: boolean
  }>(),
  { loading: false },
)

const { t } = useI18n()

const cards = computed(() => [
  { key: 'newCustomers', value: props.overview?.newCustomers },
  { key: 'newInquiries', value: props.overview?.newInquiries },
  { key: 'newQuotes', value: props.overview?.newQuotes },
  { key: 'dealsClosed', value: props.overview?.dealsClosed },
])
</script>

<template>
  <div class="manager-overview">
    <el-card
      v-for="card in cards"
      :key="card.key"
      shadow="never"
      class="manager-overview__card"
      data-testid="manager-overview-card"
    >
      <span class="manager-overview__label">{{ t(`manager.overview.${card.key}`) }}</span>
      <el-skeleton-item
        v-if="props.loading || card.value === undefined"
        variant="h1"
        class="manager-overview__pending"
      />
      <strong v-else class="manager-overview__value">{{ card.value }}</strong>
    </el-card>
  </div>
</template>

<style scoped lang="scss">
.manager-overview {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;

  &__card {
    :deep(.el-card__body) {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 16px;
    }
  }

  &__label {
    font-size: 13px;
    color: var(--tp-text-secondary);
  }

  &__value {
    font-size: 24px;
    font-weight: 700;
    line-height: 1.2;
    color: var(--tp-text-primary);
  }

  &__pending {
    width: 60%;
    height: 24px;
  }

  @media (width <= 1200px) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
