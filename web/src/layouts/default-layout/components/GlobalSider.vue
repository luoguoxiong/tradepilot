<script setup lang="ts">
import { computed, type Component } from 'vue'
import { useRoute, useRouter, type RouteLocationRaw } from 'vue-router'
import { useI18n } from 'vue-i18n'

import { useSiderCollapsed } from '@/composables/useSiderCollapsed'
import { features } from '@/features'
import {
  Aim,
  Avatar,
  Box,
  ChatDotRound,
  Checked,
  Clock,
  Collection,
  DataAnalysis,
  Document,
  Goods,
  List,
  Message,
  Odometer,
  Promotion,
  Search,
  Setting,
  Star,
  Ticket,
  Tickets,
  Timer,
  User,
  UserFilled,
} from '@element-plus/icons-vue'

import { useNotifyStore } from '@/stores/notify'
import { useAuthStore } from '@/stores/auth'

import { MENU_TREE, type MenuNode } from '../menu'

/**
 * Sider 菜单（00 §2 全局信息架构）：由 menu.ts 静态菜单树渲染，支持二级分组（el-sub-menu）。
 * 渲染前按 features.ts（编译期特性开关）与 roles（角色裁剪，口径同路由守卫，服务端 40301 为权威）整枝过滤；
 * 分组默认展开以完整呈现信息架构。1280px 以下自动折叠为图标栏（04 §4）；
 * /approvals 菜单项挂待审数角标（notifyStore 15s 轮询驱动，折叠/展开两态均可见）。
 */
const ICONS: Record<string, Component> = {
  Odometer,
  Avatar,
  User,
  Message,
  Goods,
  Ticket,
  Tickets,
  Collection,
  DataAnalysis,
  Checked,
  Setting,
  Aim,
  Search,
  ChatDotRound,
  Timer,
  Box,
  UserFilled,
  Star,
  List,
  Document,
  Clock,
  Promotion,
}

const router = useRouter()
const route = useRoute()
const { t } = useI18n()
const notifyStore = useNotifyStore()
const auth = useAuthStore()

const pendingCount = computed(() => notifyStore.pendingCount)

const { siderCollapsed: collapsed } = useSiderCollapsed()

/** 角色裁剪：roles 存在且当前角色不在其中 → 不进菜单 */
function canAccess(roles?: MenuNode['roles']): boolean {
  return !roles || (auth.user?.role !== undefined && roles.includes(auth.user.role))
}

/** 特性开关：未启用整枝剔除（与路由 filterByFeatures 同口径） */
function isEnabled(feature?: MenuNode['feature']): boolean {
  return !feature || features[feature]
}

/** 整枝过滤：分组子项全被剔除且自身无跳转目标时，分组一并剔除 */
function filterTree(nodes: MenuNode[]): MenuNode[] {
  return nodes
    .filter((node) => isEnabled(node.feature) && canAccess(node.roles))
    .map((node) => (node.children ? { ...node, children: filterTree(node.children) } : node))
    .filter((node) => !node.children || node.children.length > 0 || Boolean(node.to))
}

const menuTree = computed(() => filterTree(MENU_TREE))

/** 分组默认展开（完整呈现信息架构，仍可手动收起） */
const defaultOpeneds = computed(() =>
  menuTree.value.filter((node) => node.children?.length).map((node) => node.key),
)

function findNode(nodes: MenuNode[], key: string): MenuNode | undefined {
  for (const node of nodes) {
    if (node.key === key) return node
    if (node.children) {
      const hit = findNode(node.children, key)
      if (hit) return hit
    }
  }
  return undefined
}

/** 点击叶子：按 key 定位节点并跳转（含 ?tab= 页签深链） */
function onSelect(key: string) {
  const node = findNode(menuTree.value, key)
  if (node?.to) void router.push(node.to)
}

/** 路由 → 菜单项匹配：path + query.tab 全匹配，同一 /crm 不同页签各自高亮 */
function isActive(to: RouteLocationRaw): boolean {
  const resolved = router.resolve(to)
  if (resolved.path !== route.path) return false
  const targetTab = resolved.query.tab
  const currentTab = route.query.tab
  return String(targetTab ?? '') === String(currentTab ?? '')
}

/** 当前激活菜单 key：先匹配分组内子项，再匹配分组/一级节点自身 */
const activeKey = computed(() => {
  for (const node of menuTree.value) {
    const candidates = node.children?.length ? node.children : [node]
    const hit = candidates.find((item) => item.to && isActive(item.to))
    if (hit) return hit.key
    if (node.to && isActive(node.to)) return node.key
  }
  return route.path
})

function iconOf(name?: string): Component | undefined {
  return name ? ICONS[name] : undefined
}
</script>

<template>
  <el-menu
    class="global-sider"
    :collapse="collapsed"
    :default-active="activeKey"
    :default-openeds="defaultOpeneds"
    :collapse-transition="false"
  >
    <template v-for="node in menuTree" :key="node.key">
      <el-sub-menu v-if="node.children?.length" :index="node.key">
        <template #title>
          <el-icon v-if="iconOf(node.icon)">
            <component :is="iconOf(node.icon)" />
          </el-icon>
          <span>{{ t(node.titleKey) }}</span>
        </template>
        <el-menu-item
          v-for="child in node.children"
          :key="child.key"
          :index="child.key"
          @click="onSelect(child.key)"
        >
          <el-icon v-if="iconOf(child.icon)">
            <component :is="iconOf(child.icon)" />
          </el-icon>
          <template #title>{{ t(child.titleKey) }}</template>
        </el-menu-item>
      </el-sub-menu>

      <el-menu-item v-else :index="node.key" @click="onSelect(node.key)">
        <el-badge
          v-if="node.badge === 'approvals' && pendingCount > 0"
          :value="pendingCount"
          :max="99"
          class="global-sider__badge"
        >
          <el-icon v-if="iconOf(node.icon)">
            <component :is="iconOf(node.icon)" />
          </el-icon>
        </el-badge>
        <el-icon v-else-if="iconOf(node.icon)">
          <component :is="iconOf(node.icon)" />
        </el-icon>
        <template #title>{{ t(node.titleKey) }}</template>
      </el-menu-item>
    </template>
  </el-menu>
</template>

<style scoped lang="scss">
.global-sider {
  height: 100%;
  overflow-y: auto;
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
