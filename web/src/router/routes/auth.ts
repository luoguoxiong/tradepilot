import type { RouteRecordRaw } from 'vue-router'

import BlankLayout from '@/layouts/blank-layout/BlankLayout.vue'

/** 认证与初始化：BlankLayout（02 §1.2） */
export const authRoutes: RouteRecordRaw[] = [
  {
    path: '/',
    component: BlankLayout,
    children: [
      {
        path: 'login',
        name: 'login',
        component: () => import('@/features/auth/views/LoginView.vue'),
        meta: { public: true, title: 'auth.loginTitle' },
      },
      {
        path: 'register',
        name: 'register',
        component: () => import('@/features/auth/views/RegisterView.vue'),
        meta: { public: true, title: 'auth.registerTitle' },
      },
      {
        // 企业初始化四步向导（16 v0.4，M2）：断点续走 onboarding.currentStep
        path: 'onboarding',
        name: 'onboarding',
        component: () => import('@/features/onboarding/views/OnboardingView.vue'),
        meta: { title: 'menu.onboarding' },
      },
    ],
  },
]
