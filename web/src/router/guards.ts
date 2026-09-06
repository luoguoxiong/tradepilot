import type { Router } from 'vue-router'

import { i18n } from '@/locales'
import { useAuthStore } from '@/stores/auth'

/**
 * 守卫链装配（02 §3）：
 * 1. 认证守卫 → 2. 初始化守卫 → 3. 角色守卫 → 4. 标题（时区 dayjs 渲染在 M2 接入 org 后统一处理）
 */
export function setupRouterGuards(router: Router) {
  router.beforeEach((to) => {
    const auth = useAuthStore()

    // 1. 认证守卫：无 token 且非 public → /login?redirect=...
    if (!to.meta.public && !auth.isLoggedIn) {
      return { path: '/login', query: { redirect: to.fullPath } }
    }

    if (auth.isLoggedIn) {
      // 2. 初始化守卫：currentStep < 4 强制走 /onboarding（16 v0.4 语义）
      if (auth.needsOnboarding && to.path !== '/onboarding') {
        return '/onboarding'
      }
      if (!auth.needsOnboarding && to.path === '/onboarding') {
        return '/dashboard'
      }
    }

    // 3. 角色守卫：meta.roles 不含当前 role → 403（UX 裁剪，服务端 40301 为权威）
    const roles = to.meta.roles
    if (roles && (!auth.user || !roles.includes(auth.user.role))) {
      return '/403'
    }

    return true
  })

  // 4. 标题：meta.title(i18n) + orgName
  router.afterEach((to) => {
    const auth = useAuthStore()
    const title = to.meta.title ? i18n.global.t(to.meta.title) : i18n.global.t('common.appName')
    document.title = auth.org?.name ? `${title} · ${auth.org.name}` : `${title} · TradePilot AI`
  })
}
