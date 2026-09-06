<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import type { DataScope } from '@/api/types/common'
import { usePermission } from '@/composables/usePermission'

/**
 * ScopeSelect 数据范围切换（04 §2.2 / 05 §2）：
 * sales 固定 self 不渲染；manager 可选 self/team；admin 可选 self/team/all。
 * scope 值由父组件写入 URL query（列表状态可分享）。
 */
const props = withDefaults(defineProps<{ modelValue?: DataScope; disabled?: boolean }>(), {
  modelValue: 'self',
  disabled: false,
})

const emit = defineEmits<{ 'update:modelValue': [value: DataScope] }>()

const { t } = useI18n()
const { maxScope } = usePermission()

const SCOPES: DataScope[] = ['self', 'team', 'all']
const LATEST_FIRST: Record<DataScope, number> = { self: 0, team: 1, all: 2 }

const options = computed(() => {
  const max = LATEST_FIRST[maxScope.value]
  return SCOPES.filter((s) => LATEST_FIRST[s] <= max)
})

function onChange(value: DataScope) {
  emit('update:modelValue', value)
}
</script>

<template>
  <!-- sales 无可选项：整个控件不渲染（05 §2） -->
  <el-select
    v-if="options.length > 1"
    class="scope-select"
    :model-value="props.modelValue"
    :disabled="props.disabled"
    size="default"
    @update:model-value="onChange"
  >
    <el-option
      v-for="scope in options"
      :key="scope"
      :value="scope"
      :label="t(`enums.scope.${scope}`)"
    />
  </el-select>
</template>

<style scoped lang="scss">
.scope-select {
  width: 120px;
}
</style>
