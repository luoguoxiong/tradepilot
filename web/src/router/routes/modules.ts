import type { RouteRecordRaw } from 'vue-router'

const placeholder = () => import('@/views/PlaceholderView.vue')
const errorPage = () => import('@/views/ErrorPageView.vue')

/**
 * 主布局子路由（02 §2 路由表）。
 * ★ = P0；P1 路由注册但带 meta.feature，由 features.ts 构建期剔除（02 §5.1）。
 */
export const appRoutes: RouteRecordRaw[] = [
  {
    path: '/',
    component: () => import('@/layouts/default-layout/DefaultLayout.vue'),
    redirect: '/dashboard',
    children: [
      // ===== P0 =====
      {
        path: 'dashboard',
        name: 'dashboard',
        component: () => import('@/features/dashboard/views/DashboardView.vue'),
        meta: { title: 'menu.dashboard', icon: 'Odometer', menu: true, order: 1 },
      },
      {
        path: 'ai-employees',
        name: 'ai-employees',
        component: () => import('@/features/employees/views/AiEmployeesView.vue'),
        meta: { title: 'menu.aiEmployees', icon: 'Avatar', menu: true, order: 2 },
      },
      {
        path: 'lead-gen',
        name: 'lead-gen',
        component: () => import('@/features/lead-gen/views/LeadGenView.vue'),
        meta: { title: 'menu.leadGen', icon: 'Aim', menu: true, order: 3 },
      },
      {
        path: 'lead-gen/leads',
        name: 'lead-discover',
        component: () => import('@/features/lead-gen/views/LeadDiscoverView.vue'),
        meta: { title: 'menu.leadDiscover' },
      },
      {
        path: 'crm',
        name: 'crm',
        component: () => import('@/features/crm/views/CrmView.vue'),
        meta: { title: 'menu.crm', icon: 'User', menu: true, order: 4 },
      },
      {
        path: 'crm/contacts',
        name: 'crm-contacts',
        component: () => import('@/features/crm/views/CrmView.vue'),
        meta: { title: 'menu.contacts' },
      },
      {
        path: 'inbox',
        name: 'inbox',
        component: () => import('@/features/inbox/views/InboxView.vue'),
        meta: { title: 'menu.inbox', icon: 'Message', menu: true, order: 5, fullHeight: true },
      },
      {
        path: 'outreach',
        name: 'outreach',
        component: placeholder,
        meta: { title: 'menu.outreach', icon: 'Promotion', menu: true, order: 6 },
      },
      {
        path: 'follow-up',
        name: 'follow-up',
        component: () => import('@/features/follow-up/views/FollowUpTasksView.vue'),
        meta: { title: 'menu.followUp', icon: 'Timer', menu: true, order: 7 },
      },
      {
        path: 'follow-up/strategies',
        name: 'follow-up-strategies',
        component: () => import('@/features/follow-up/views/FollowUpStrategiesView.vue'),
        meta: { title: 'menu.followUpStrategies' },
      },
      // 邮件模板 P1 先例：导航「即将上线」占位
      {
        path: 'templates',
        name: 'templates',
        component: placeholder,
        meta: { title: 'menu.templates', icon: 'Document', menu: true, order: 8 },
      },
      {
        path: 'knowledge',
        name: 'knowledge',
        component: () => import('@/features/knowledge/views/KnowledgeView.vue'),
        meta: { title: 'menu.knowledge', icon: 'Collection', menu: true, order: 9 },
      },
      {
        path: 'approvals',
        name: 'approvals',
        component: () => import('@/features/approvals/views/ApprovalsView.vue'),
        meta: { title: 'menu.approvals', icon: 'Checked', menu: true, order: 10 },
      },
      {
        // 系统设置（16）：子路由不进全局 Sider，由 SettingsLayout 内导航承载
        path: 'settings',
        name: 'settings',
        component: () => import('@/features/settings/views/SettingsLayout.vue'),
        meta: { title: 'menu.settings', icon: 'Setting', menu: true, order: 11 },
        children: [
          { path: '', redirect: { name: 'settings-org' } },
          {
            path: 'org',
            name: 'settings-org',
            component: () => import('@/features/settings/views/OrgInfoView.vue'),
            meta: { title: 'settings.orgInfo' },
          },
          {
            path: 'members',
            name: 'settings-members',
            component: () => import('@/features/settings/views/MembersView.vue'),
            meta: { title: 'settings.members' },
          },
          {
            path: 'mailboxes',
            name: 'settings-mailboxes',
            component: () => import('@/features/settings/views/MailboxesView.vue'),
            meta: { title: 'settings.mailboxes' },
          },
          {
            path: 'approval-rules',
            name: 'settings-approval-rules',
            component: () => import('@/features/settings/views/ApprovalRulesView.vue'),
            meta: { title: 'settings.approvalRules' },
          },
          {
            path: 'notifications',
            name: 'settings-notifications',
            component: () => import('@/features/settings/views/NotificationsView.vue'),
            meta: { title: 'settings.notifications' },
          },
          {
            path: 'ai-employees',
            name: 'settings-ai-employees',
            component: () => import('@/features/settings/views/AiEmployeesEntryView.vue'),
            meta: { title: 'settings.aiEmployees' },
          },
          // ===== P1 设置页（FR-06/07/10/11 全量交付）=====
          {
            path: 'crm-integration',
            name: 'settings-crm-integration',
            component: () => import('@/features/settings/views/CrmIntegrationView.vue'),
            // 读取 admin+manager、写入仅 admin（与后端 @Roles 一致）
            meta: { title: 'settings.crmIntegration', roles: ['admin', 'manager'] },
          },
          {
            path: 'pricing-rules',
            name: 'settings-pricing-rules',
            component: () => import('@/features/settings/views/PricingRulesView.vue'),
            // 读取 admin+manager、写入仅 admin（与后端 @Roles 一致）
            meta: { title: 'settings.pricingRules', roles: ['admin', 'manager'] },
          },
          {
            path: 'ai-models',
            name: 'settings-ai-models',
            component: () => import('@/features/settings/views/AiModelsView.vue'),
            // 模型/供应商配置属敏感配置，仅 admin 可见（与后端 @Roles('admin') 一致）
            meta: { title: 'settings.aiModels', roles: ['admin'] },
          },
          {
            path: 'api-keys',
            name: 'settings-api-keys',
            component: () => import('@/features/settings/views/ApiKeysView.vue'),
            // API Key / Webhook 凭证属敏感配置，仅 admin 可见（与后端 @Roles('admin') 一致）
            meta: { title: 'settings.apiKeys', roles: ['admin'] },
          },
        ],
      },
      // 详情类路由（不进菜单；04 客户 360°，页签状态随 ?tab= query，02 §4.2）
      {
        path: 'customers/:id',
        name: 'customer-360',
        component: () => import('@/features/customer360/views/Customer360View.vue'),
        meta: { title: 'menu.crm' },
      },

      // ===== P1（features.ts 控制，p0 构建期剔除） =====
      // 14 AI 任务中心（P1）：状态 Tab 列表 + 详情（步骤/日志/产出物 + 操作/审批联动）
      {
        path: 'tasks',
        name: 'tasks',
        component: () => import('@/features/tasks/views/TasksListView.vue'),
        meta: { title: 'menu.tasks', icon: 'List', menu: true, order: 20, feature: 'taskCenter' },
      },
      // 详情类路由（不进菜单，与 04 customers/:id 同构：列表视图不含内层 router-view）
      {
        path: 'tasks/:id',
        name: 'task-detail',
        component: () => import('@/features/tasks/views/TaskDetailView.vue'),
        meta: { title: 'menu.tasks', feature: 'taskCenter' },
      },
      // 08 产品中心（P1）：列表 + 详情（5 页签，?tab= 同步）
      {
        path: 'products',
        name: 'products',
        component: () => import('@/features/products/views/ProductsListView.vue'),
        meta: { title: 'menu.products', icon: 'Goods', menu: true, order: 21, feature: 'products' },
      },
      // 详情类路由（不进菜单；列表视图不含内层 router-view，故与 04 customers/:id 同构平铺）
      {
        path: 'products/:id',
        name: 'product-detail',
        component: () => import('@/features/products/views/ProductDetailView.vue'),
        meta: { title: 'menu.products', feature: 'products' },
      },
      {
        path: 'quotes',
        name: 'quotes',
        component: () => import('@/features/quotes/views/QuotesListView.vue'),
        meta: { title: 'menu.quotes', icon: 'Ticket', menu: true, order: 22, feature: 'quotes' },
      },
      {
        path: 'quotes/:id',
        name: 'quote-detail',
        component: () => import('@/features/quotes/views/QuoteDetailView.vue'),
        meta: { title: 'menu.quotes', feature: 'quotes' },
      },
      {
        path: 'orders',
        name: 'orders',
        component: () => import('@/features/orders/views/OrdersListView.vue'),
        meta: { title: 'menu.orders', icon: 'Tickets', menu: true, order: 23, feature: 'orders' },
      },
      // 详情类路由（不进菜单，与 04 customers/:id 同构：列表视图不含内层 router-view）
      {
        path: 'orders/:id',
        name: 'order-detail',
        component: () => import('@/features/orders/views/OrderDetailView.vue'),
        meta: { title: 'menu.orders', feature: 'orders' },
      },
      {
        path: 'manager',
        name: 'manager',
        component: placeholder,
        meta: {
          title: 'menu.manager',
          icon: 'UserFilled',
          menu: true,
          order: 24,
          feature: 'manager',
        },
      },
      {
        path: 'data-center',
        name: 'data-center',
        component: () => import('@/features/data-center/views/DataCenterView.vue'),
        meta: {
          title: 'menu.dataCenter',
          icon: 'DataAnalysis',
          menu: true,
          order: 25,
          feature: 'dataCenter',
        },
      },

      // ===== 错误页 =====
      {
        path: '403',
        name: 'forbidden',
        component: errorPage,
        meta: { title: 'errors.forbiddenTitle', errorType: '403' },
      },
      {
        path: ':pathMatch(.*)*',
        name: 'not-found',
        component: errorPage,
        meta: { title: 'errors.notFoundTitle', errorType: '404' },
      },
    ],
  },
]
