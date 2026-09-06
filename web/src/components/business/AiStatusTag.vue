<script setup lang="ts">
import { computed } from 'vue'

import { useDictStore } from '@/stores/dict'
import type { EnumGroup } from '@/utils/enum-map'

/**
 * AiStatusTag 员工/任务状态标签（04 §2.2）：
 * dictStore 枚举 → Design Tokens 语义色；statusDetail 走 Tooltip（D4 外贸经理占位说明等）。
 */
const props = withDefaults(
  defineProps<{
    group: EnumGroup
    value: string | null | undefined
    detail?: string | null
    size?: 'small' | 'default'
  }>(),
  { detail: null, size: 'default' },
)

const dict = useDictStore()

const label = computed(() => dict.label(props.group, props.value))
const color = computed(() => dict.color(props.group, props.value) ?? 'var(--ai-idle)')
</script>

<template>
  <el-tooltip :content="props.detail ?? undefined" :disabled="!props.detail" placement="top">
    <span class="ai-status-tag">
      <span class="ai-status-tag__dot" :style="{ background: color }" />
      <span class="ai-status-tag__label" :style="{ color }">{{ label }}</span>
    </span>
  </el-tooltip>
</template>

<style scoped lang="scss">
.ai-status-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: default;

  &__dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  &__label {
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
  }
}
</style>
