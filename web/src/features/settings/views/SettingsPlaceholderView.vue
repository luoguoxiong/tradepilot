<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'

import EmptyState from '@/components/business/EmptyState.vue'

/** P1 设置子页占位（AD-4 / 菜单占位先例）：FR-06 / FR-07 / FR-10 / FR-11 */
const route = useRoute()
const { t } = useI18n()

const title = computed(() => t(String(route.meta.title ?? 'common.comingSoon')))
</script>

<template>
  <EmptyState type="fallback" :title="title" :description="t('placeholder.description')" />
</template>
