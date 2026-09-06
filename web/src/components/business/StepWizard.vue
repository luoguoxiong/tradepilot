<script setup lang="ts">
import { useI18n } from 'vue-i18n'

/**
 * StepWizard 分步向导（04 §2.2）：员工创建 / 企业初始化共用。
 * current 为 1 起步的当前步骤；支持断点续走（父组件持有 onboarding.currentStep）。
 */
const props = defineProps<{
  steps: { key: string; title: string }[]
  current: number
}>()

const { t } = useI18n()

const activeIndex = () => Math.max(0, Math.min(props.current - 1, props.steps.length - 1))
</script>

<template>
  <el-steps class="step-wizard" :active="activeIndex()" align-center finish-status="success">
    <el-step
      v-for="(step, index) in props.steps"
      :key="step.key"
      :title="t(step.title)"
      :description="index + 1 < props.current ? t('onboarding.stepDone') : undefined"
    />
  </el-steps>
</template>

<style scoped lang="scss">
.step-wizard {
  padding: calc(var(--tp-spacing-base) * 6) 0;
}
</style>
