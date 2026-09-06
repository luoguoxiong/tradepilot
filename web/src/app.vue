<script setup lang="ts">
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import enLocale from 'element-plus/es/locale/lang/en'
import zhCnLocale from 'element-plus/es/locale/lang/zh-cn'

import { useAppStore } from '@/stores/app'

const appStore = useAppStore()
const { locale } = useI18n()

// 语言切换：vue-i18n 与 Element Plus locale 同步（01 §6）
watch(
  () => appStore.locale,
  (lang) => {
    locale.value = lang
  },
  { immediate: true },
)

const elLocale = computed(() => (appStore.locale === 'en' ? enLocale : zhCnLocale))
</script>

<template>
  <el-config-provider :locale="elLocale">
    <router-view />
  </el-config-provider>
</template>
