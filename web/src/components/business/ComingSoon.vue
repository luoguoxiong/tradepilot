<script setup lang="ts">
import { useI18n } from 'vue-i18n'

/** P1 置灰占位统一组件（02 §5.2 三种降级手段之一，AD-4 配套） */
const props = defineProps<{
  text?: string
}>()

const { t } = useI18n()
</script>

<template>
  <span class="coming-soon">
    <el-tag type="info" size="small" effect="plain" round>
      {{ props.text ?? t('common.comingSoon') }}
    </el-tag>
  </span>
</template>

<style scoped lang="scss">
.coming-soon {
  display: inline-flex;
}
</style>
