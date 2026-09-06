<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'

import EmptyState from '@/components/business/EmptyState.vue'

/** AI 员工配置（16 FR-04）：设置侧仅提供入口跳转 02-AI数字员工中心，不重复实现 */
const router = useRouter()
const { t } = useI18n()
</script>

<template>
  <EmptyState
    type="fallback"
    :title="t('settings.aiEmployees')"
    :description="t('settings.aiEmployeesHint')"
  >
    <el-button type="primary" @click="router.push('/ai-employees')">
      {{ t('settings.goAiEmployees') }}
    </el-button>
  </EmptyState>
</template>
