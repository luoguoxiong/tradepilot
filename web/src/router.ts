import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/profiles' },
    {
      path: '/profiles',
      name: 'profiles',
      component: () => import('./views/Profiles.vue'),
      meta: { title: '产品档案' }
    },
    {
      path: '/prospecting',
      name: 'prospecting',
      component: () => import('./views/Prospecting.vue'),
      meta: { title: '找客户' }
    },
    {
      path: '/leads',
      name: 'leads',
      component: () => import('./views/Leads.vue'),
      meta: { title: '线索列表' }
    },
    {
      path: '/leads/:id',
      name: 'lead-detail',
      component: () => import('./views/LeadDetail.vue'),
      props: true,
      meta: { title: '客户报告' }
    },
    {
      path: '/leads/:id/email',
      name: 'lead-email',
      component: () => import('./views/EmailView.vue'),
      props: true,
      meta: { title: '开发信' }
    },
    // ===== 二期：订单跟单 =====
    {
      path: '/anomalies',
      name: 'anomalies',
      component: () => import('./views/Anomalies.vue'),
      meta: { title: '异常看板' }
    },
    {
      path: '/orders',
      name: 'orders',
      component: () => import('./views/Orders.vue'),
      meta: { title: '订单台账' }
    },
    {
      path: '/orders/:id',
      name: 'order-detail',
      component: () => import('./views/OrderDetail.vue'),
      props: true,
      meta: { title: '订单详情' }
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('./views/Settings.vue'),
      meta: { title: '设置' }
    }
  ],
  scrollBehavior: () => ({ top: 0 })
})

// 同步页面标题
router.afterEach((to) => {
  const title = to.meta.title as string | undefined
  document.title = title ? `${title} · TradePilot` : 'TradePilot · 智能客户开发'
})

export default router
