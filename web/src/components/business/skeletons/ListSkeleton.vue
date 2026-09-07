<script setup lang="ts">
withDefaults(defineProps<{ rows?: number }>(), { rows: 6 })

/**
 * ListSkeleton 列表页骨架（06 §4 感知性能三套骨架之一）：
 * 筛选工具栏 + 表格行占位；列表首查渲染（缓存命中不渲染）。
 */
</script>

<template>
  <div class="list-skeleton" data-testid="skeleton-list">
    <el-skeleton :rows="1" animated style="width: 280px" />
    <div class="list-skeleton__rows">
      <el-skeleton v-for="i in rows" :key="i" :rows="1" animated class="list-skeleton__row" />
    </div>
  </div>
</template>

<style scoped lang="scss">
.list-skeleton {
  &__rows {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 16px;
  }

  &__row {
    padding: 10px 12px;
    border: 1px solid var(--tp-border-light, #e4e7ed);
    border-radius: 8px;
  }
}
</style>
