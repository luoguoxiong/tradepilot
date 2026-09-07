<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Delete, Plus, Top, Bottom } from '@element-plus/icons-vue'

import type { StrategyStep } from '@/api/types/follow-up'

/**
 * RhythmEditor 跟进节奏行编辑器（04 §3.5）：
 * 「第 N 天 + 动作」行编辑，可增删排序；校验 Day 偏移唯一且递增（07 §3.3 42201 前端预检）。
 * 内容：知识模板 / 内联文本二选一；Break-up 节点强制内联 + 人工审核提示（07 §4）。
 */
const props = defineProps<{ modelValue: StrategyStep[] }>()
const emit = defineEmits<{ 'update:modelValue': [steps: StrategyStep[]] }>()

const { t } = useI18n()

/** 跟进内容模板（来自 11 知识中心内容素材，MVP 种子枚举） */
const TEMPLATE_OPTIONS = [
  { value: 'tpl_intro', labelKey: 'followUp.tpl.intro' },
  { value: 'tpl_value', labelKey: 'followUp.tpl.value' },
  { value: 'tpl_case', labelKey: 'followUp.tpl.case' },
  { value: 'tpl_customer', labelKey: 'followUp.tpl.customer' },
] as const

function notify(steps: StrategyStep[]) {
  emit('update:modelValue', steps)
}

function addStep() {
  const last = props.modelValue[props.modelValue.length - 1]
  const nextDay = last ? last.dayOffset + 3 : 0
  notify([
    ...props.modelValue,
    { seq: props.modelValue.length + 1, dayOffset: nextDay, title: '', channel: 'email' },
  ])
}

function removeStep(index: number) {
  notify(props.modelValue.filter((_, i) => i !== index))
}

function moveStep(index: number, offset: -1 | 1) {
  const target = index + offset
  if (target < 0 || target >= props.modelValue.length) return
  const steps = [...props.modelValue]
  ;[steps[index], steps[target]] = [steps[target], steps[index]]
  notify(steps)
}

function patchStep(index: number, patch: Partial<StrategyStep>) {
  notify(props.modelValue.map((step, i) => (i === index ? { ...step, ...patch } : step)))
}

/** 内容模式：模板 / 内联二选一（07 §1.4 steps[].templateId | content） */
function contentMode(step: StrategyStep): 'template' | 'inline' {
  return step.templateId ? 'template' : 'inline'
}

function onModeChange(index: number, step: StrategyStep, mode: unknown) {
  if (mode === 'template') {
    patchStep(index, { templateId: TEMPLATE_OPTIONS[0].value, content: undefined })
  } else if (mode === 'inline') {
    patchStep(index, { templateId: undefined, content: step.content ?? '' })
  }
}

function onBreakupChange(index: number, step: StrategyStep, value: unknown) {
  const checked = Boolean(value)
  if (checked) {
    // Break-up 强制内联内容 + 人工审核（07 §4）
    patchStep(index, { isBreakup: true, templateId: undefined, content: step.content ?? '' })
  } else {
    patchStep(index, { isBreakup: false })
  }
}

function templateLabel(value: string | undefined): string {
  const option = TEMPLATE_OPTIONS.find((o) => o.value === value)
  return option ? t(option.labelKey) : '—'
}

/** 提交前校验：标题必填 / Day 唯一且递增 / 内容二选一非空（07 §2.1 设计说明 2） */
function validate(): string | null {
  const steps = props.modelValue
  if (steps.length === 0) return t('followUp.rhythmEmpty')
  for (const [index, step] of steps.entries()) {
    if (!step.title.trim()) return t('followUp.stepTitleRequired', { seq: index + 1 })
    if (!Number.isInteger(step.dayOffset) || step.dayOffset < 0) {
      return t('followUp.dayInvalid', { seq: index + 1 })
    }
    if (step.templateId) continue
    if (!step.content || !step.content.trim()) {
      return t('followUp.stepContentRequired', { seq: index + 1 })
    }
  }
  for (let i = 1; i < steps.length; i += 1) {
    if (steps[i].dayOffset === steps[i - 1].dayOffset) {
      return t('followUp.dayDuplicated')
    }
    if (steps[i].dayOffset < steps[i - 1].dayOffset) {
      return t('followUp.dayNotIncreasing')
    }
  }
  return null
}

defineExpose({ validate, templateLabel })
</script>

<template>
  <div class="rhythm">
    <div v-for="(step, index) in props.modelValue" :key="index" class="rhythm__row">
      <div class="rhythm__head">
        <span class="rhythm__seq">#{{ index + 1 }}</span>
        <span class="rhythm__day">
          {{ t('followUp.dayPrefix') }}
          <el-input-number
            :model-value="step.dayOffset"
            :min="0"
            :max="365"
            size="small"
            controls-position="right"
            style="width: 96px"
            @update:model-value="(v: number | undefined) => patchStep(index, { dayOffset: v ?? 0 })"
          />
        </span>
        <el-input
          :model-value="step.title"
          :placeholder="t('followUp.stepTitlePlaceholder')"
          size="small"
          style="flex: 1"
          @update:model-value="(v: string) => patchStep(index, { title: v })"
        />
        <el-select
          :model-value="step.channel"
          size="small"
          disabled
          style="width: 104px"
          :placeholder="t('followUp.channelEmail')"
        />
        <el-button-group size="small">
          <el-button :icon="Top" :disabled="index === 0" @click="moveStep(index, -1)" />
          <el-button
            :icon="Bottom"
            :disabled="index === props.modelValue.length - 1"
            @click="moveStep(index, 1)"
          />
        </el-button-group>
        <el-button size="small" type="danger" plain :icon="Delete" @click="removeStep(index)" />
      </div>

      <div class="rhythm__content">
        <el-radio-group
          v-if="!step.isBreakup"
          :model-value="contentMode(step)"
          size="small"
          @update:model-value="(v: string | number | boolean | undefined) => onModeChange(index, step, v)"
        >
          <el-radio-button value="template">{{ t('followUp.contentTemplate') }}</el-radio-button>
          <el-radio-button value="inline">{{ t('followUp.contentInline') }}</el-radio-button>
        </el-radio-group>

        <el-select
          v-if="!step.isBreakup && contentMode(step) === 'template'"
          :model-value="step.templateId"
          size="small"
          style="width: 220px"
          @update:model-value="(v: string) => patchStep(index, { templateId: v })"
        >
          <el-option
            v-for="option in TEMPLATE_OPTIONS"
            :key="option.value"
            :label="t(option.labelKey)"
            :value="option.value"
          />
        </el-select>

        <el-input
          v-if="step.isBreakup || contentMode(step) === 'inline'"
          :model-value="step.content"
          type="textarea"
          :rows="2"
          :placeholder="t('followUp.contentPlaceholder')"
          style="flex: 1; min-width: 240px"
          @update:model-value="(v: string) => patchStep(index, { content: v })"
        />

        <el-tooltip
          :content="t('followUp.breakupTip')"
          :disabled="!step.isBreakup"
          placement="top"
        >
          <el-checkbox
            :model-value="Boolean(step.isBreakup)"
            :label="t('followUp.breakupCheckbox')"
            size="small"
            @update:model-value="(v: string | number | boolean | undefined) => onBreakupChange(index, step, v)"
          />
        </el-tooltip>
      </div>
    </div>

    <el-button size="small" :icon="Plus" @click="addStep">{{ t('followUp.addStep') }}</el-button>
  </div>
</template>

<style scoped lang="scss">
.rhythm {
  &__row {
    padding: 10px;
    margin-bottom: 8px;
    border: 1px solid var(--tp-border-color);
    border-radius: var(--tp-radius-base, 8px);
  }

  &__head {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  &__seq {
    font-weight: 600;
    color: var(--tp-text-secondary);
  }

  &__day {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 13px;
    color: var(--tp-text-secondary);
  }

  &__content {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    flex-wrap: wrap;
  }
}
</style>
