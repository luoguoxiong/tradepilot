/**
 * 01-Dashboard 工作台（接口文档 01 v0.3）：
 * 只读聚合视图；D1~D3 随模块交付逐项恢复——
 * kpis 全量 new_customers/new_inquiries/new_quotes/estimated_revenue（§3.1）、
 * pendingItems 四类（§3.1）、dailyReport 经 /dashboard/daily-report 单独拉取（D3，随 13）。
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
  'quote_approval' | 'high_value_overdue' | 'customer_reply' | 'order_delay_risk'

/** 今日待处理项（01 §1.5）：点击按 link 携带预置筛选跳转 */
export interface DashboardPendingItem {
  type: DashboardPendingType
  count: number
  level: 'danger' | 'warning' | 'info'
  link: string
}

/**
 * AI 每日报告（01 §3.2 GET /dashboard/daily-report，D3 随 13 恢复）：
 * content 为五段 Markdown；无报告时接口返回 40401（前端按「暂无报告 + 可生成」渲染）。
 */
export interface DashboardDailyReport {
  reportId: string
  period: 'daily' | 'weekly' | 'monthly'
  status: 'generating' | 'ready' | 'failed'
  content: string | null
  generatedAt: string | null
  citations: Record<string, unknown>[]
}

/** 生成请求/响应（01 §3.3 POST /dashboard/daily-report/generate，异步任务） */
export interface GenerateDailyReportReq {
  period?: 'daily' | 'weekly' | 'monthly'
}

export interface GenerateDailyReportResp {
  taskId: string
  reportId: string
  /** 异步任务状态（queued/running）；报告状态经 GET /dashboard/daily-report 轮询 */
  status: string
  period: string
}

/** 首屏聚合（01 §3.1 GET /dashboard/summary） */
export interface DashboardSummary {
  greeting: { onlineEmployeeCount: number; onlineEmployeeTotal: number }
  /** D1 全量：new_customers/new_inquiries/new_quotes/estimated_revenue */
  kpis: DashboardKpi[]
  aiEmployees: DashboardEmployee[]
  highValueCustomers: DashboardHighValueCustomer[]
  /** D2 全量四类 */
  pendingItems: DashboardPendingItem[]
  /** 报告正文经 /dashboard/daily-report 单独拉取（首屏不内联） */
  dailyReport?: never
}
