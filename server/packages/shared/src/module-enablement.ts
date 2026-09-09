/**
 * 模块启用判定器（M5-A1 · 00 产品总览 §5.1 D1~D12 降级矩阵统一收口）。
 *
 * 口径（§5.1 通用规则）：P0/P1 边界由交付版本决定，不做运行时功能开关 UI；
 * 聚合接口只返回已启用模块的数据（未启用 metric 不返回，而非返回 0）。
 * 本文件为「模块是否启用」的**唯一事实源**：
 * - 01 Dashboard / 04 客户 360° / 06 Copilot / 12 审核中心 Tab 等聚合口径一律消费本判定；
 * - P1 模块交付时将对应条目翻转为 'p0' 即恢复（D1~D12 逐项回落，无需改消费方）。
 *
 * D 矩阵 → 模块键对照：
 * - D1/D2  Dashboard KPI·待办（新报价/预计成交额/报价待审/订单延期）→ quote_center / order_center
 * - D3/D4  AI 每日报告、外贸经理卡片 → ai_manager
 * - D6     04 Quotes/Orders 页签 → quote_center / order_center
 * - D7     04 Products 跳 08 → product_center
 * - D8/D9  06 建议分流、结构化参数来源 → quote_center / product_center
 * - D10    12 审核中心分类 Tab（quote/order_change/bulk_marketing 来源）→ quote_center / order_center
 * - D11    11 产品资料自动归档 → product_center
 * - D5     02 currentTask 轻量对象（P0 只读聚合，无依赖）与 14 完整操作 → task_ops
 * - D12    16 设置菜单占位（FR-06/07/11）→ 见 16 文档交付注记
 */

/** 可判定的业务模块键（P1 扩展模块；P0 常驻模块不在此列） */
export const MODULE_KEY = {
  /** 08 产品中心 */
  PRODUCT_CENTER: 'product_center',
  /** 09 报价中心 */
  QUOTE_CENTER: 'quote_center',
  /** 10 订单中心 */
  ORDER_CENTER: 'order_center',
  /** 13 AI 外贸经理 */
  AI_MANAGER: 'ai_manager',
  /** 14 任务完整操作（pause/resume/cancel/transfer） */
  TASK_OPS: 'task_ops',
  /** 15 数据中心 */
  DATA_CENTER: 'data_center',
} as const;

export type ModuleKey = (typeof MODULE_KEY)[keyof typeof MODULE_KEY];

/** 交付阶段：'p0' 已启用 / 'p1' 未启用（降级矩阵生效） */
export type ModulePhase = 'p0' | 'p1';

/**
 * 模块交付阶段登记表（唯一事实源）。
 * P0 基线：全部 P1 模块未启用；对应模块交付时逐项翻转为 'p0'。
 */
export const MODULE_PHASE: Record<ModuleKey, ModulePhase> = {
  [MODULE_KEY.PRODUCT_CENTER]: 'p1',
  [MODULE_KEY.QUOTE_CENTER]: 'p1',
  [MODULE_KEY.ORDER_CENTER]: 'p1',
  [MODULE_KEY.AI_MANAGER]: 'p1',
  [MODULE_KEY.TASK_OPS]: 'p1',
  [MODULE_KEY.DATA_CENTER]: 'p1',
};

/** 模块是否启用：聚合接口按此决定是否返回对应 metric/页签/建议（§5.1「隐藏」降级） */
export function isModuleEnabled(module: ModuleKey): boolean {
  return MODULE_PHASE[module] === 'p0';
}

/** 当前启用模块清单（调试/聚合入口自检用） */
export function listEnabledModules(): ModuleKey[] {
  return (Object.keys(MODULE_PHASE) as ModuleKey[]).filter((m) => isModuleEnabled(m));
}
