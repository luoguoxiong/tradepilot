<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'

import GlobalHeader from './components/GlobalHeader.vue'
import GlobalSider from './components/GlobalSider.vue'
import { KEEP_ALIVE_INCLUDE, keepAliveKey } from './keep-alive'
import { useAppStore } from '@/stores/app'
import { useNotifyStore } from '@/stores/notify'

/**
 * DefaultLayout（02 §1.1）：Header 64 + Sider 240/64 + 内容区（最大 1600px 居中）。
 * 挂载即启动待审数 15s 轮询（03 §5.2），页面隐藏暂停由 notifyStore 内部处理。
 * 内容区 router-view 外包 keep-alive（02 §6）：高频列表页保活（白名单见 keep-alive.ts），
 * 缓存 key 含 query 页签参数，避免返回丢失筛选状态；客户 360° 不在白名单内不入保活。
 */
const appStore = useAppStore()
const notifyStore = useNotifyStore()

const siderWidth = computed(() =>
  appStore.siderCollapsed ? 'var(--tp-sider-collapsed-width)' : 'var(--tp-sider-width)',
)

onMounted(() => notifyStore.startPolling())
onUnmounted(() => notifyStore.stopPolling())
</script>

<template>
  <el-container class="default-layout">
    <el-aside :width="siderWidth">
      <GlobalSider />
    </el-aside>
    <el-container>
      <el-header height="var(--tp-header-height)">
        <GlobalHeader />
      </el-header>
      <el-main>
        <div class="default-layout__content">
          <router-view v-slot="{ Component, route }">
            <keep-alive :include="KEEP_ALIVE_INCLUDE">
              <component :is="Component" :key="keepAliveKey(route)" />
            </keep-alive>
          </router-view>
        </div>
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

  &__content {
    max-width: var(--tp-content-max-width);
    margin: 0 auto;
  }
}
</style>
