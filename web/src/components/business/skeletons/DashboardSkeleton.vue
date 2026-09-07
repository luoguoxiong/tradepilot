<script setup lang="ts">
/**
 * DashboardSkeleton Dashboard 工作台骨架（06 §4 感知性能三套骨架之一）：
 * 问候区 + KPI 卡组 + 主体两栏占位；首屏聚合接口加载期间渲染。
 */
</script>

<template>
  <div class="dashboard-skeleton" data-testid="skeleton-dashboard">
    <div class="dashboard-skeleton__greeting">
      <el-skeleton :rows="1" animated style="width: 320px" />
      <el-skeleton :rows="1" animated style="width: 160px" />
    </div>
    <div class="dashboard-skeleton__kpis">
      <el-skeleton v-for="i in 2" :key="i" :rows="2" animated class="dashboard-skeleton__kpi" />
    </div>
    <div class="dashboard-skeleton__body">
      <el-skeleton :rows="4" animated class="dashboard-skeleton__panel" />
      <div class="dashboard-skeleton__side">
        <el-skeleton :rows="2" animated class="dashboard-skeleton__panel" />
        <el-skeleton :rows="2" animated class="dashboard-skeleton__panel" />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.dashboard-skeleton {
  &__greeting {
    display: flex;
    justify-content: space-between;
  }

  &__kpis {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
    margin: 16px 0;
  }

  &__kpi,
  &__panel {
    padding: 16px;
    background: var(--el-bg-color);
    border: 1px solid var(--tp-border-light, #e4e7ed);
    border-radius: 8px;
  }

  &__body {
    display: grid;
    grid-template-columns: 3fr 2fr;
    gap: 12px;
  }

  &__side {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
}
</style>
