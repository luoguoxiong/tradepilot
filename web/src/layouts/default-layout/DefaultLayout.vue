<script setup lang="ts">
import GlobalHeader from './components/GlobalHeader.vue'
import GlobalSider from './components/GlobalSider.vue'
import { useAppStore } from '@/stores/app'

const appStore = useAppStore()
</script>

<template>
  <el-container class="default-layout">
    <el-aside
      :width="appStore.siderCollapsed ? 'var(--tp-sider-collapsed-width)' : 'var(--tp-sider-width)'"
    >
      <GlobalSider />
    </el-aside>
    <el-container>
      <el-header height="var(--tp-header-height)">
        <GlobalHeader />
      </el-header>
      <el-main>
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped lang="scss">
.default-layout {
  height: 100vh;

  :deep(.el-aside) {
    transition: width 0.2s ease;
    overflow-x: hidden;
  }

  :deep(.el-header) {
    padding: 0;
    background: var(--tp-bg-container);
    border-bottom: 1px solid var(--tp-border-color);
  }

  :deep(.el-main) {
    padding: calc(var(--tp-spacing-base) * 4);
    overflow-y: auto;
  }
}
</style>
