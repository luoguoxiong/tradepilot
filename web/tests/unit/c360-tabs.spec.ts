import { describe, expect, it } from 'vitest'

import { CRM_TABS, LEAD_TABS, visibleC360Tabs } from '@/features/customer360/utils/tabs'

/**
 * D6（04 §3.1 / FR-02）客户 360° 页签：
 * - CRM 客户：Quotes 随 09（features.quotes）、Orders 随 10（features.orders）启用后渲染；
 * - 未入库客户（inCrm=false，获客「查看 →」跳转）：仅 Overview / Contacts / Products；
 * - 09/10 未启用时对应页签隐藏（P0 降级），且不改变其余页签顺序。
 */
const P0 = {
  quotes: false,
  orders: false,
  products: false,
  manager: false,
  taskCenter: false,
  dataCenter: false,
}
const P1 = {
  ...P0,
  quotes: true,
  orders: true,
  products: true,
  manager: true,
  taskCenter: true,
  dataCenter: true,
}

describe('visibleC360Tabs（D6 Quotes/Orders 页签按启用模块渲染）', () => {
  it('P1（09/10 启用）：CRM 客户渲染全量页签且顺序与 04 FR-02 一致', () => {
    expect(visibleC360Tabs(true, P1)).toEqual(CRM_TABS)
    expect(visibleC360Tabs(true, P1)).toEqual([
      'overview',
      'contacts',
      'products',
      'conversations',
      'quotes',
      'orders',
      'activities',
      'insights',
    ])
  })

  it('P0（09/10 未启用）：隐藏 Quotes / Orders，其余保留', () => {
    const tabs = visibleC360Tabs(true, P0)
    expect(tabs).not.toContain('quotes')
    expect(tabs).not.toContain('orders')
    expect(tabs).toEqual([
      'overview',
      'contacts',
      'products',
      'conversations',
      'activities',
      'insights',
    ])
  })

  it('仅启用 09：仅 Quotes 出现（Orders 仍隐藏）', () => {
    const tabs = visibleC360Tabs(true, { ...P0, quotes: true })
    expect(tabs).toContain('quotes')
    expect(tabs).not.toContain('orders')
  })

  it('未入库客户（inCrm=false）：仅前三个基础页签，与 features 无关', () => {
    expect(visibleC360Tabs(false, P1)).toEqual(LEAD_TABS)
    expect(visibleC360Tabs(false, P0)).toEqual(LEAD_TABS)
  })
})
