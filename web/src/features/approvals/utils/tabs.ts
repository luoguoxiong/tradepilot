import type { FeatureKey } from '@/features'
import { features } from '@/features'

/**
 * D10「Tab 按启用模块渲染」（12 FR-01 / 00 §5.1 D10）：
 * 审批类型 → 来源模块特性开关。服务端 `summary` 恒返回常驻类型
 * （`email_send` / `customer_delete` / `quote` / `order_change`，count=0 也在列），
 * 由前端按来源模块是否启用裁剪 —— quote 随 09 报价中心、order_change 随 10 订单中心。
 *
 * 未映射类型（`contract` / `bulk_marketing`：P1 无来源模块）后端仅在确有待审数据时返回，
 * 此处一律保留（有数据必须可审，不做二次隐藏）。
 */
export const APPROVAL_TAB_FEATURES: Partial<Record<string, FeatureKey>> = {
  quote: 'quotes',
  order_change: 'orders',
}

/** 过滤出当前版本可展示的 Tab（保持服务端返回顺序） */
export function visibleApprovalTabs<T extends { type: string }>(
  tabs: T[],
  enabled: Record<FeatureKey, boolean> = features,
): T[] {
  return tabs.filter((tab) => {
    const featureKey = APPROVAL_TAB_FEATURES[tab.type]
    return !featureKey || enabled[featureKey]
  })
}
