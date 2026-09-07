<script setup lang="ts">
withDefaults(defineProps<{ fields?: number; rows?: number }>(), { fields: 4, rows: 3 })

/**
 * DetailSkeleton 详情页骨架（06 §4 感知性能三套骨架之一）：
 * 头部信息块 + 字段栅格 + 正文块；详情/360° 首查渲染。
 */
</script>

<template>
  <div class="detail-skeleton" data-testid="skeleton-detail">
    <el-skeleton :rows="2" animated class="detail-skeleton__header" />
    <div class="detail-skeleton__fields">
      <el-skeleton v-for="i in fields" :key="i" :rows="1" animated />
    </div>
    <el-skeleton v-for="i in rows" :key="`r${i}`" :rows="3" animated class="detail-skeleton__block" />
  </div>
</template>

<style scoped lang="scss">
.detail-skeleton {
  &__header {
    padding: 16px;
    border: 1px solid var(--tp-border-light, #e4e7ed);
    border-radius: 8px;
  }

  &__fields {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
    margin: 16px 0;
  }

  &__block {
    margin-bottom: 16px;
  }
}
</style>
