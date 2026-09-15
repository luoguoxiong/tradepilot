import { describe, expect, it } from 'vitest'

import { visibleApprovalTabs } from '@/features/approvals/utils/tabs'

/**
 * D10（12 FR-01 / 00 §5.1）审核中心 Tab 按启用模块渲染：
 * - P1 全开：常驻类型（email_send/customer_delete/quote/order_change）全部保留；
 * - P0 档位：09/10 未启用 → 报价 / 订单变更 Tab 裁剪，P0 来源与「确有数据」的类型保留；
 * - 顺序与「全部」Tab 不受影响。
 */
const TABS = [
  { type: 'all', count: 3 },
  { type: 'email_send', count: 1 },
  { type: 'customer_delete', count: 0 },
  { type: 'quote', count: 2 },
  { type: 'order_change', count: 0 },
  { type: 'contract', count: 1 }, // 后端仅在确有数据时返回
]

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

describe('visibleApprovalTabs（D10 分类 Tab 按启用模块渲染）', () => {
  it('P1（09/10 启用）：保留报价 / 订单变更常驻 Tab', () => {
    expect(visibleApprovalTabs(TABS, P1).map((t) => t.type)).toEqual([
      'all',
      'email_send',
      'customer_delete',
      'quote',
      'order_change',
      'contract',
    ])
  })

  it('P0（09/10 未启用）：裁剪报价 / 订单变更，其余保留（含确有数据的 contract）', () => {
    const types = visibleApprovalTabs(TABS, P0).map((t) => t.type)
    expect(types).toEqual(['all', 'email_send', 'customer_delete', 'contract'])
    expect(types).not.toContain('quote')
    expect(types).not.toContain('order_change')
  })

  it('仅启用其中一个模块时互不影响', () => {
    expect(visibleApprovalTabs(TABS, { ...P0, quotes: true }).map((t) => t.type)).toEqual([
      'all',
      'email_send',
      'customer_delete',
      'quote',
      'contract',
    ])
  })
})
