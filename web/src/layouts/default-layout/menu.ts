import type { RouteLocationRaw } from 'vue-router'

import type { FeatureKey } from '@/features'
import type { Role } from '@/api/types/common'

/**
 * Sider 菜单树（对齐 [00-产品总览 §2 全局信息架构](../../../../产品需求文档/00-产品总览与MVP规划.md)）。
 *
 * 与路由解耦：叶子节点用 `to` 描述跳转目标（可携带 `?tab=` 页签深链），
 * 分组节点用 `children` 承载二级菜单（el-sub-menu）。
 * `feature`（features.ts 编译期开关）与 `roles`（角色裁剪）在渲染前整枝过滤，
 * 口径与路由守卫一致（服务端 40301 为权威）。
 */
export interface MenuNode {
  /** el-menu index，全局唯一 */
  key: string
  /** i18n key（locales.menu.*） */
  titleKey: string
  /** Element Plus 图标组件名（GlobalSider ICONS） */
  icon?: string
  /** 叶子跳转目标；分组节点无自身页面时省略 */
  to?: RouteLocationRaw
  /** 二级菜单 */
  children?: MenuNode[]
  /** 编译期特性开关，未启用则整枝剔除 */
  feature?: FeatureKey
  /** 角色裁剪（UX 层，服务端 40301 为权威） */
  roles?: Role[]
  /** 待审数角标（AI 审核中心） */
  badge?: 'approvals'
}

/** 全局一级/二级菜单（顺序即展示顺序） */
export const MENU_TREE: MenuNode[] = [
  {
    key: 'dashboard',
    titleKey: 'menu.dashboard',
    icon: 'Odometer',
    to: { path: '/dashboard' },
  },
  {
    // AI 数字员工：分组标题仅承载展开/收起，子项为角色工作台入口
    key: 'ai-employees',
    titleKey: 'menu.aiEmployees',
    icon: 'Avatar',
    children: [
      {
        key: 'ai-lead-hunter',
        titleKey: 'menu.aiLeadHunter',
        icon: 'Aim',
        to: { path: '/lead-gen' },
      },
      {
        key: 'ai-follow-up',
        titleKey: 'menu.aiFollowUp',
        icon: 'Timer',
        to: { path: '/follow-up' },
      },
      {
        key: 'ai-manager',
        titleKey: 'menu.manager',
        icon: 'UserFilled',
        to: { path: '/manager' },
        feature: 'manager',
        roles: ['admin', 'manager'],
      },
    ],
  },
  {
    key: 'crm',
    titleKey: 'menu.crm',
    icon: 'User',
    to: { path: '/crm' },
  },
  {
    key: 'sales',
    titleKey: 'menu.sales',
    icon: 'Message',
    children: [
      { key: 'sales-inbox', titleKey: 'menu.inbox', icon: 'ChatDotRound', to: { path: '/inbox' } },
      {
        key: 'sales-outreach',
        titleKey: 'menu.outreach',
        icon: 'Promotion',
        to: { path: '/outreach' },
      },
      {
        key: 'sales-follow-up',
        titleKey: 'menu.followUp',
        icon: 'Timer',
        to: { path: '/follow-up' },
      },
      {
        key: 'sales-templates',
        titleKey: 'menu.templates',
        icon: 'Document',
        to: { path: '/templates' },
      },
    ],
  },
  {
    key: 'products',
    titleKey: 'menu.products',
    icon: 'Goods',
    to: { path: '/products' },
    feature: 'products',
  },
  {
    key: 'quotes',
    titleKey: 'menu.quotes',
    icon: 'Ticket',
    to: { path: '/quotes' },
    feature: 'quotes',
  },
  {
    key: 'orders',
    titleKey: 'menu.orders',
    icon: 'Tickets',
    to: { path: '/orders' },
    feature: 'orders',
  },
  {
    key: 'knowledge',
    titleKey: 'menu.knowledge',
    icon: 'Collection',
    to: { path: '/knowledge' },
  },
  {
    key: 'data-center',
    titleKey: 'menu.dataCenter',
    icon: 'DataAnalysis',
    to: { path: '/data-center' },
    feature: 'dataCenter',
  },
  {
    key: 'approvals',
    titleKey: 'menu.approvals',
    icon: 'Checked',
    to: { path: '/approvals' },
    badge: 'approvals',
  },
  {
    key: 'settings',
    titleKey: 'menu.settings',
    icon: 'Setting',
    to: { path: '/settings' },
  },
]
