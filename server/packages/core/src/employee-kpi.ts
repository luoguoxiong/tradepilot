/**
 * 02 AI 数字员工 · 角色与 KPI 口径常量（单一实现点）。
 *
 * 02 §3.2「KPI 口径定义」P1 精化：每角色固定 1 个日指标（`period=daily`），
 * 达成值 = **业务表实时聚合**（不再是 P0 的 `ai_task` 计数），
 * 目标值 target 由企业自填（角色模板给建议值）。
 *
 * 本文件同时被 API DTO（角色枚举 / 创建校验）、db 层聚合（`employee-kpi.ts`）
 * 与 13 团队效率（同一份达成值）引用，避免多处定义导致 02 / 13 数字漂移。
 */

/** 02 §1.1 六角色（顺序即卡片墙顺序，对齐预置员工） */
export const EMPLOYEE_ROLES = [
  'lead_hunter',
  'customer_researcher',
  'sales',
  'follow_up',
  'merchandiser',
  'manager',
] as const;

export type EmployeeRole = (typeof EMPLOYEE_ROLES)[number];

/** 02 §3.2 全部 KPI 指标（每角色固定 1 个） */
export const KPI_METRICS = [
  'daily_leads',
  'daily_profiles',
  'daily_replies',
  'daily_followups',
  'active_orders',
  'daily_reports',
] as const;

export type KpiMetric = (typeof KPI_METRICS)[number];

/**
 * 角色 → KPI metric 固定映射（02 §1.1 注 / §3.2 表）。
 * 创建员工时 `kpiConfig.metric` 必须与角色匹配，否则 42201。
 */
export const ROLE_KPI_METRIC: Record<EmployeeRole, KpiMetric> = {
  lead_hunter: 'daily_leads',
  customer_researcher: 'daily_profiles',
  sales: 'daily_replies',
  follow_up: 'daily_followups',
  merchandiser: 'active_orders',
  manager: 'daily_reports',
};

/**
 * 「按职能统计」而非「按 AI 员工归因」的指标（02 §3.2 聚合来源决定的现实口径）：
 * - `daily_followups`：跟进执行（`follow_up_execution`）由策略驱动，明细无 AI 员工外键；
 * - `active_orders`：在跟订单数（`sales_order` 存量）本就与「今日」无关，也无 AI 员工归属。
 * 这类指标按 org 维度统计，同角色员工共享同一数值（默认每角色 1 名员工）。
 * 其余指标均可经 `ai_task.employee_id` 或 `customer_activity.operator_id` 归因到具体员工。
 */
export const ROLE_SCOPED_KPI_METRICS: readonly KpiMetric[] = ['daily_followups', 'active_orders'];
