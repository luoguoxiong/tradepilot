<script setup lang="ts">
import { computed, type Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useWindowSize } from '@vueuse/core'
import {
  Aim,
  Avatar,
  Checked,
  Collection,
  DataAnalysis,
  Document,
  Goods,
  List,
  Message,
  Odometer,
  Promotion,
  Setting,
  Ticket,
  Tickets,
  Timer,
  User,
  UserFilled,
} from '@element-plus/icons-vue'

import { useAppStore } from '@/stores/app'
import { useNotifyStore } from '@/stores/notify'

/**
 * Sider 菜单由路由表自动生成（02 §1.1）：meta.menu !== false，按 features.ts 过滤、meta.order 排序。
 * 1280px 以下自动折叠为图标栏（04 §4 响应式约定）；折叠状态与用户手动开关取并集。
 * /approvals 菜单项挂待审数角标（M5-B5，notifyStore 15s 轮询驱动，折叠/展开两态均可见）。
 */
const ICONS: Record<string, Component> = {
  Odometer,
  Avatar,
  Aim,
  User,
  Message,
  Promotion,
  Timer,
  Document,
  Collection,
  Checked,
  Setting,
  List,
  Goods,
  Ticket,
  Tickets,
  UserFilled,
  DataAnalysis,
}

const router = useRouter()
const route = useRoute()
const { t } = useI18n()
const appStore = useAppStore()
const notifyStore = useNotifyStore()

const pendingCount = computed(() => notifyStore.pendingCount)

const { width } = useWindowSize()

const collapsed = computed(() => appStore.siderCollapsed || width.value < 1280)

const menuItems = computed(() =>
  router
    .getRoutes()
    .filter((r) => r.meta.menu)
    .sort((a, b) => (a.meta.order ?? 99) - (b.meta.order ?? 99))
    .map((r) => ({ path: r.path, titleKey: r.meta.title ?? '', icon: r.meta.icon })),
)

/** 父级路由高亮：/settings/org 等子路由仍点亮菜单父项 */
const activePath = computed(() => {
  const match = menuItems.value.find(
    (item) => item.path !== '/' && route.path.startsWith(`${item.path}/`),
  )
  return match?.path ?? route.path
})

function iconOf(name?: string): Component | undefined {
  return name ? ICONS[name] : undefined
}
</script>

<template>
  <el-menu
    class="global-sider"
    :collapse="collapsed"
    :default-active="activePath"
    :collapse-transition="false"
    router
  >
    <el-menu-item v-for="item in menuItems" :key="item.path" :index="item.path">
      <el-badge
        v-if="item.path === '/approvals' && pendingCount > 0"
        :value="pendingCount"
        :max="99"
        class="global-sider__badge"
      >
        <el-icon v-if="iconOf(item.icon)">
          <component :is="iconOf(item.icon)" />
        </el-icon>
      </el-badge>
      <el-icon v-else-if="iconOf(item.icon)">
        <component :is="iconOf(item.icon)" />
      </el-icon>
      <template #title>{{ t(item.titleKey) }}</template>
    </el-menu-item>
  </el-menu>
</template>

<style scoped lang="scss">
.global-sider {
  height: 100%;
  border-right: 1px solid var(--tp-border-color);

  &:not(.el-menu--collapse) {
    width: var(--tp-sider-width);
  }

  &__badge {
    display: inline-flex;
    align-items: center;

    :deep(.el-badge__content) {
      z-index: 2;
    }
  }
}
</style>
