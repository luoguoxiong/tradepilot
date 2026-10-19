/**
 * 01-Dashboard 工作台 DTO（接口 01 §3.1，M5-D2）。
 * 响应形状与 web/src/api/types/dashboard.ts 前端契约逐字段对齐；
 * D1/D2 随 09/10 交付恢复全量 metric/待处理类型；D3 随 13 交付恢复每日报告接口。
 */
import { z } from 'zod';
import { MANAGER_REPORT_PERIODS } from '@tradepilot/core';

/** GET /dashboard/summary 查询（scope 缺省取角色上限，controller 侧 resolveScope 收窄） */
export const dashboardQuerySchema = z.object({
  scope: z.enum(['self', 'team', 'all']).optional(),
});

export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

/** 01 §1.2 FR-02 KPI metric（P0 仅 new_customers/new_inquiries） */
export type DashboardMetric =
  'new_customers' | 'new_inquiries' | 'new_quotes' | 'estimated_revenue';

/** KPI 卡（01 §1.2）：value 数值或金额；trend 语义色 up/down/flat */
export interface DashboardKpi {
  metric: DashboardMetric;
  value: number | string;
  /** 金额类 KPI 币种（estimated_revenue 默认 USD；计数类不携带） */
  currency?: string;
  /** 环比变化百分比，如 20 表示 ↑20% */
  changePct: number;
  trend: 'up' | 'down' | 'flat';
  comparePeriod: string;
}

/** AI 员工工作状态（01 §1.3 FR-03） */
export interface DashboardEmployee {
  employeeId: string;
  name: string;
  role: string;
  status: 'working' | 'waiting_approval' | 'idle' | 'error';
  currentAction: string;
  todayOutput: { label: string; count: number; unit: string };
  /** 等待审核任务数（waiting_approval 时展示） */
  waitingApprovalCount?: number;
}

/** 高价值客户（01 §1.4 FR-04）：点击跳客户 360° */
export interface DashboardHighValueCustomer {
  customerId: string;
  companyName: string;
  score: number;
  country?: string;
}

/** 今日待处理类型（01 §1.5 FR-05；P0 仅 high_value_overdue/customer_reply） */
export type DashboardPendingType =
  'quote_approval' | 'high_value_overdue' | 'customer_reply' | 'order_delay_risk';

/** 今日待处理项（01 §1.5）：点击按 link 携带预置筛选跳转 */
export interface DashboardPendingItem {
  type: DashboardPendingType;
  count: number;
  level: 'danger' | 'warning' | 'info';
  link: string;
}

/** 首屏聚合（01 §3.1 GET /dashboard/summary） */
export interface DashboardSummary {
  greeting: { onlineEmployeeCount: number; onlineEmployeeTotal: number };
  kpis: DashboardKpi[];
  aiEmployees: DashboardEmployee[];
  highValueCustomers: DashboardHighValueCustomer[];
  pendingItems: DashboardPendingItem[];
  /** D3：入口随 13 启用（报告正文经 /dashboard/daily-report 单独拉取，首屏不内联） */
  dailyReport?: never;
}

/**
 * 01 §3.2 GET /dashboard/daily-report 响应（D3：随 13 恢复；无报告时 40401）。
 * 与 13 `ManagerReportDetail` 同源（period 收敛到日报/周报/月报）。
 */
export interface DashboardDailyReport {
  reportId: string;
  period: 'daily' | 'weekly' | 'monthly';
  status: 'generating' | 'ready' | 'failed';
  content: string | null;
  generatedAt: string | null;
  citations: unknown[];
}

/** 01 §3.3 POST /dashboard/daily-report/generate 请求（缺省日报） */
export const generateDailyReportSchema = z.object({
  period: z.enum(MANAGER_REPORT_PERIODS).default('daily'),
});

export type GenerateDailyReportDto = z.infer<typeof generateDailyReportSchema>;

/**
 * 01 §3.3 响应：异步任务 id（+ 报告 id 便于前端直接轮询详情）。
 * `status` 为**异步任务**状态（queued/running，来自 13 报告任务入队），
 * 报告自身状态（generating/ready/failed）经 GET /dashboard/daily-report 获取。
 */
export interface GenerateDailyReportResp {
  taskId: string;
  reportId: string;
  status: string;
  period: string;
}
