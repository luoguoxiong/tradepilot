/**
 * 01-Dashboard 工作台（接口文档 01 v0.2）：
 * 只读聚合视图；P0 降级对齐 00 §5.1 D1~D3——
 * kpis 无 new_quotes/estimated_revenue、pendingItems 无 quote_approval/order_delay_risk、
 * 无 dailyReport 字段（未启用 metric/入口不返回而非返回 0）。
 */

/** KPI metric（01 §1.2 FR-02） */
export type DashboardMetric = 'new_customers' | 'new_inquiries' | 'new_quotes' | 'estimated_revenue'

/** KPI 卡（01 §1.2）：value 数值或金额；trend 语义色 up/down/flat */
export interface DashboardKpi {
  metric: DashboardMetric
  value: number | string
  /** 金额类 KPI 币种，默认 USD（estimated_revenue 为估算值，前端标注「预计」） */
  currency?: string
  /** 环比变化百分比，如 20 表示 ↑20% */
  changePct: number
  trend: 'up' | 'down' | 'flat'
  comparePeriod: string
}

/** AI 员工工作状态（01 §1.3 FR-03） */
export interface DashboardEmployee {
  employeeId: string
  name: string
  role: string
  status: 'working' | 'waiting_approval' | 'idle' | 'error'
  currentAction: string
  todayOutput: { label: string; count: number; unit: string }
  /** 等待审核任务数（waiting_approval 时展示） */
  waitingApprovalCount?: number
}

/** 高价值客户（01 §1.4 FR-04）：点击跳客户 360° */
export interface DashboardHighValueCustomer {
  customerId: string
  companyName: string
  score: number
  country?: string
}

/** 今日待处理类型（01 §1.5 FR-05） */
export type DashboardPendingType =
  | 'quote_approval'
  | 'high_value_overdue'
  | 'customer_reply'
  | 'order_delay_risk'

/** 今日待处理项（01 §1.5）：点击按 link 携带预置筛选跳转 */
export interface DashboardPendingItem {
  type: DashboardPendingType
  count: number
  level: 'danger' | 'warning' | 'info'
  link: string
}

/** AI 每日报告入口（01 §1.1；P0 D3 不返回，前端隐藏） */
export interface DashboardDailyReport {
  reportId: string
  status: string
}

/** 首屏聚合（01 §3.1 GET /dashboard/summary） */
export interface DashboardSummary {
  greeting: { onlineEmployeeCount: number; onlineEmployeeTotal: number }
  /** P0 仅 new_customers/new_inquiries（D1）；P1 恢复全量 */
  kpis: DashboardKpi[]
  aiEmployees: DashboardEmployee[]
  highValueCustomers: DashboardHighValueCustomer[]
  /** P0 仅 high_value_overdue/customer_reply（D2） */
  pendingItems: DashboardPendingItem[]
  /** P0 D3：字段不返回 */
  dailyReport?: DashboardDailyReport
}
