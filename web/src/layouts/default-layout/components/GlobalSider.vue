<script setup lang="ts">
import { computed, type Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
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

/**
 * Sider 菜单由路由表自动生成（02 §1.1）：meta.menu !== false，按 features.ts 过滤、meta.order 排序。
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

const menuItems = computed(() =>
  router
    .getRoutes()
    .filter((r) => r.meta.menu)
    .sort((a, b) => (a.meta.order ?? 99) - (b.meta.order ?? 99))
    .map((r) => ({ path: r.path, titleKey: r.meta.title ?? '', icon: r.meta.icon })),
)

function iconOf(name?: string): Component | undefined {
  return name ? ICONS[name] : undefined
}
</script>

<template>
  <el-menu
    class="global-sider"
    :collapse="appStore.siderCollapsed"
    :default-active="route.path"
    :collapse-transition="false"
    router
  >
    <el-menu-item v-for="item in menuItems" :key="item.path" :index="item.path">
      <el-icon v-if="iconOf(item.icon)">
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
}
</style>
