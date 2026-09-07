<script setup lang="ts">
import { computed } from 'vue'

import { formatMoney } from '@/utils/format'

/**
 * MoneyText 金额展示组件（04 §2.2）：
 * - amount 字符串十进制（接口规范 §2.1）+ currency（ISO 4217，缺省 USD）→ 本地化货币格式；
 * - 防 float：展示走 formatMoney（Decimal 解析），金额计算一律 decimal.js（01 §6）；
 * - 空值 / 非法值渲染「—」。
 */
const props = withDefaults(
  defineProps<{
    /** 字符串十进制金额（如 "12500.00"） */
    amount: string | number | null | undefined
    /** ISO 4217 币种码，缺省 USD（03 §7） */
    currency?: string
  }>(),
  { currency: 'USD' },
)

const text = computed(() => formatMoney(props.amount, props.currency))
</script>

<template>
  <span class="money-text">{{ text }}</span>
</template>

<style scoped lang="scss">
.money-text {
  font-variant-numeric: tabular-nums;
}
</style>
