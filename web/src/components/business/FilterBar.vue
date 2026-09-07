<script setup lang="ts">
import { useI18n } from 'vue-i18n'

import { useDictStore } from '@/stores/dict'
import type { EnumGroup } from '@/utils/enum-map'

/**
 * FilterBar 筛选区（02 §4.1）：schema 生成筛选控件，值变化即向上同步
 * （ProTable 将其并入 query key → 筛选变更即新 key，缓存保留可回退，03 §5.2）。
 */
export interface FilterField {
  prop: string
  /** i18n placeholder key */
  labelKey: string
  type: 'input' | 'select'
  enumGroup?: EnumGroup
  /** 显式 options（已本地化），优先于 enumGroup */
  options?: { value: string; label: string }[]
  width?: number
}

const props = defineProps<{
  fields: FilterField[]
  modelValue: Record<string, unknown>
}>()

const emit = defineEmits<{ 'update:modelValue': [value: Record<string, unknown>] }>()

const { t } = useI18n()
const dict = useDictStore()

function optionsFor(field: FilterField) {
  if (field.options) return field.options
  if (field.enumGroup) {
    return dict
      .options(field.enumGroup)
      .map((o) => ({ value: o.value as string, label: t(o.labelKey) }))
  }
  return []
}

function stringValue(prop: string): string {
  const value = props.modelValue[prop]
  return typeof value === 'string' ? value : ''
}

function setValue(prop: string, value: unknown) {
  emit('update:modelValue', { ...props.modelValue, [prop]: value })
}

function widthOf(field: FilterField): string {
  return `${field.width ?? 180}px`
}
</script>

<template>
  <div class="filter-bar">
    <el-input
      v-for="field in props.fields.filter((f) => f.type === 'input')"
      :key="field.prop"
      :model-value="stringValue(field.prop)"
      :placeholder="t(field.labelKey)"
      clearable
      :style="{ width: widthOf(field) }"
      @update:model-value="setValue(field.prop, $event || undefined)"
      @clear="setValue(field.prop, undefined)"
    />
    <el-select
      v-for="field in props.fields.filter((f) => f.type === 'select')"
      :key="field.prop"
      :model-value="stringValue(field.prop) || undefined"
      :placeholder="t(field.labelKey)"
      clearable
      :style="{ width: widthOf(field) }"
      @update:model-value="setValue(field.prop, $event || undefined)"
    >
      <el-option
        v-for="option in optionsFor(field)"
        :key="option.value"
        :value="option.value"
        :label="option.label"
      />
    </el-select>
    <slot />
  </div>
</template>

<style scoped lang="scss">
.filter-bar {
  display: flex;
  align-items: center;
  gap: calc(var(--tp-spacing-base) * 2);
  flex-wrap: wrap;
  margin-bottom: calc(var(--tp-spacing-base) * 3);
}
</style>
