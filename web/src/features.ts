/**
 * 编译期特性开关（技术方案 02 §5.1，AD-4）。
 * P0/P1 边界由交付版本决定（VITE_FEATURES_PROFILE），不做运行时功能开关 UI；
 * 路由、菜单、页签、卡片、推荐动作四处读取同一份常量，features.ts 的 diff 即交付清单。
 */
export type FeatureKey = 'quotes' | 'orders' | 'products' | 'manager' | 'taskCenter' | 'dataCenter'

const PROFILE: 'p0' | 'p1' = import.meta.env.VITE_FEATURES_PROFILE ?? 'p0'
const P1_ENABLED = PROFILE === 'p1'

export const features = {
  /** 09 报价中心（P1） */
  quotes: P1_ENABLED,
  /** 10 订单中心（P1） */
  orders: P1_ENABLED,
  /** 08 产品中心（P1） */
  products: P1_ENABLED,
  /** 13 AI 外贸经理（P1） */
  manager: P1_ENABLED,
  /** 14 AI 任务中心（P1；其任务接口为 P0 依赖） */
  taskCenter: P1_ENABLED,
  /** 15 数据中心（P1） */
  dataCenter: P1_ENABLED,
} as const satisfies Record<FeatureKey, boolean>
