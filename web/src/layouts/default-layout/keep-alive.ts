import type { RouteLocationNormalizedLoaded } from 'vue-router'

/**
 * 02 §6：keep-alive include 白名单（高频列表页：CRM / 发现列表 / 审批）。
 * 组件须以 defineOptions({ name }) 声明与之一致的 name，include 按组件 name 匹配；
 * 客户 360° 不入保活（数据新鲜度优先），表单类页面离开用 useFormLeaveGuard 拦截。
 * 新增列表页：在此登记 + 组件命名。
 */
export const KEEP_ALIVE_INCLUDE: string[] = [
  'DashboardView',
  'CrmView',
  'LeadDiscoverView',
  'InboxView',
  'ApprovalsView',
  'FollowUpTasksView',
  'KnowledgeView',
]

/**
 * 02 §6：缓存 key 含路由 query 页签参数 —— 同一 path 下不同 tab 各自独立缓存，
 * 返回时恢复各自筛选状态；无页签参数时按 path 单实例（页签为组件内部态）。
 */
export function keepAliveKey(route: RouteLocationNormalizedLoaded): string {
  const tab = typeof route.query.tab === 'string' ? route.query.tab : ''
  return tab ? `${route.path}?tab=${tab}` : route.path
}
