import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

import { features } from '@/features'

import { authRoutes } from './routes/auth'
import { appRoutes } from './routes/modules'
import { setupRouterGuards } from './guards'

/** meta.feature 未启用的路由整枝剔除（02 §5.1：四处读取同一份常量） */
function filterByFeatures(routes: RouteRecordRaw[]): RouteRecordRaw[] {
  return routes
    .filter((route) => {
      const feature = route.meta?.feature
      return !feature || features[feature]
    })
    .map((route) =>
      route.children ? { ...route, children: filterByFeatures(route.children) } : route,
    )
}

const routes = filterByFeatures([...authRoutes, ...appRoutes])

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

setupRouterGuards(router)
