import type { FeatureKey } from '@/features'
import { features } from '@/features'

/** 04 客户 360° 页签（FR-02：Overview / Contacts / Products / Conversations / Quotes / Orders / Activities / AI Insights） */
export type C360Tab =
  | 'overview'
  | 'contacts'
  | 'products'
  | 'conversations'
  | 'quotes'
  | 'orders'
  | 'activities'
  | 'insights'

export const DEFAULT_TAB: C360Tab = 'overview'

/** 未入库客户（inCrm=false，来自获客跳转）仅可见基础页签（04 §3.1） */
export const LEAD_TABS: C360Tab[] = ['overview', 'contacts', 'products']

/** CRM 客户全量页签（Quotes / Orders 随 09/10 启用，见 `TAB_FEATURES`） */
export const CRM_TABS: C360Tab[] = [
  ...LEAD_TABS,
  'conversations',
  'quotes',
  'orders',
  'activities',
  'insights',
]

/** D6：页签 → 来源模块特性开关（Quotes 随 09、Orders 随 10） */
export const C360_TAB_FEATURES: Partial<Record<C360Tab, FeatureKey>> = {
  quotes: 'quotes',
  orders: 'orders',
}

/** 当前可见页签（inCrm + 来源模块启用；P0 下 Quotes/Orders 隐藏 —— D6） */
export function visibleC360Tabs(
  inCrm: boolean,
  enabled: Record<FeatureKey, boolean> = features,
): C360Tab[] {
  const base = inCrm ? CRM_TABS : LEAD_TABS
  return base.filter((tab) => {
    const featureKey = C360_TAB_FEATURES[tab]
    return !featureKey || enabled[featureKey]
  })
}
