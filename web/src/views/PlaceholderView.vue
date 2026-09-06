<script setup lang="ts">
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'

import EmptyState from '@/components/business/EmptyState.vue'

/** 未交付模块的骨架占位页（M1：菜单/路由可导航） */
const route = useRoute()
const { t } = useI18n()
</script>

<template>
  <div class="placeholder-view">
    <el-card shadow="never" class="placeholder-view__card">
      <template #header>
        <span class="placeholder-view__title">{{
          route.meta.title ? t(route.meta.title) : ''
        }}</span>
      </template>
      <EmptyState type="fallback" :description="t('placeholder.description')" />
    </el-card>
  </div>
</template>

<style scoped lang="scss">
.placeholder-view {
  max-width: var(--tp-content-max-width);
  margin: 0 auto;
  padding: calc(var(--tp-spacing-base) * 6);

  &__card {
    border-radius: var(--tp-border-radius-base);
  }

  &__title {
    font-weight: 600;
  }
}
</style>
