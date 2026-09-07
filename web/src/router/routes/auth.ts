import type { RouteRecordRaw } from 'vue-router'

import BlankLayout from '@/layouts/blank-layout/BlankLayout.vue'

/**
 * 认证与初始化（02 §1.2）：BlankLayout。
 * 注意：不能定义 path:'/' 根记录 —— 与 appRoutes 的 '/'（DefaultLayout + redirect）冲突，
 * vue-router 按注册顺序取先注册者，会让 '/' 落到无匹配子路由的 BlankLayout 上白屏；
 * 故拆为三个顶级记录（空 path 子路由承载视图），URL 保持 /login、/register、/onboarding 不变。
 */
export const authRoutes: RouteRecordRaw[] = [
  {
    path: '/login',
    component: BlankLayout,
    children: [
      {
        path: '',
        name: 'login',
        component: () => import('@/features/auth/views/LoginView.vue'),
        meta: { public: true, title: 'auth.loginTitle' },
      },
    ],
  },
  {
    path: '/register',
    component: BlankLayout,
    children: [
      {
        path: '',
        name: 'register',
        component: () => import('@/features/auth/views/RegisterView.vue'),
        meta: { public: true, title: 'auth.registerTitle' },
      },
    ],
  },
  {
    path: '/onboarding',
    component: BlankLayout,
    children: [
      {
        // 企业初始化四步向导（16 v0.4，M2）：断点续走 onboarding.currentStep
        path: '',
        name: 'onboarding',
        component: () => import('@/features/onboarding/views/OnboardingView.vue'),
        meta: { title: 'menu.onboarding' },
      },
    ],
  },
]
