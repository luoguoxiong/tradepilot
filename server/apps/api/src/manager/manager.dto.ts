/**
 * 13 AI 外贸经理 DTO（页面级字段与接口文档 13 §1/§3，P1-13）。
 * 字段与前端契约 web/src/api/types/manager.ts 一一对应（唯一事实源）。
 */
import { z } from 'zod';
import { DISCOVERY_TYPES, MANAGER_REPORT_PERIODS } from '@tradepilot/core';
import { paginationQuerySchema } from '@tradepilot/shared';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const dateSchema = z.string().trim().regex(DATE_PATTERN, '日期格式应为 YYYY-MM-DD');

/** §3.1 GET /manager/overview：date 缺省今天（org 时区当地日） */
export const managerOverviewQuerySchema = z.object({
  date: dateSchema.optional(),
  /** 数据权限（00 §4.4；越权值由 resolveScope 收敛到角色上限） */
  scope: z.enum(['self', 'team', 'all']).optional(),
});
export type ManagerOverviewQuery = z.infer<typeof managerOverviewQuerySchema>;

/** §3.2 GET /manager/discoveries：type 过滤（机会 / 风险 / 全部） */
export const managerDiscoveriesQuerySchema = z.object({
  type: z.enum(['all', ...DISCOVERY_TYPES]).default('all'),
  scope: z.enum(['self', 'team', 'all']).optional(),
});
export type ManagerDiscoveriesQuery = z.infer<typeof managerDiscoveriesQuerySchema>;

/** §3.4 POST /manager/reports/generate：period 决定区间（org 时区日历口径） */
export const generateReportSchema = z.object({
  period: z.enum(MANAGER_REPORT_PERIODS).default('daily'),
});
export type GenerateReportDto = z.infer<typeof generateReportSchema>;

/** 报告列表：period 过滤 + 分页（pageSize ≤100） */
export const listReportsQuerySchema = paginationQuerySchema.extend({
  period: z.enum(['all', ...MANAGER_REPORT_PERIODS]).default('all'),
  scope: z.enum(['self', 'team', 'all']).optional(),
});
export type ListReportsQuery = z.infer<typeof listReportsQuerySchema>;

// ===== 响应契约（13 §1/§3） =====

/** §1.1 今日经营概览（四项核心指标，与 15 数据中心同源） */
export interface ManagerOverviewResp {
  newCustomers: number;
  newInquiries: number;
  newQuotes: number;
  dealsClosed: number;
}

/** 发现证据（Insight Schema：text 必填，source/ref 供下钻） */
export interface DiscoveryEvidenceDto {
  text: string;
  source?: string;
  ref?: string;
}

/** 一键建议（action 白名单封闭，见 core MANAGER_DISCOVERY_ACTIONS） */
export interface DiscoverySuggestionDto {
  label: string;
  action: string;
  payload: Record<string, unknown>;
}

/** §1.2 发现项 */
export interface DiscoveryItemDto {
  discoveryId: string;
  type: string;
  title: string;
  detail: string;
  evidence: DiscoveryEvidenceDto[];
  suggestion: DiscoverySuggestionDto;
  /** 只读展示文案（由 suggestion.action 映射，不单独传参） */
  actions: string;
  /** new（待处理）/ executed（已执行，executedRef 记录产物） */
  status: string;
  executedRef: Record<string, unknown> | null;
  executedAt: string | null;
  createdAt: string;
}

export interface DiscoveryListResp {
  items: DiscoveryItemDto[];
}

/** §1.3 团队效率行：target 未配置时不返回 kpiPct/metric/target/achieved/period */
export interface TeamEfficiencyItemDto {
  employeeId: string;
  role: string;
  name: string;
  kpiPct?: number;
  metric?: string;
  achieved?: number;
  target?: number;
  period?: string;
}

export interface TeamEfficiencyResp {
  items: TeamEfficiencyItemDto[];
}

/** §3.3 一键执行结果（按 action 分流返回 taskId / strategyId） */
export interface ExecuteDiscoveryResp {
  discoveryId: string;
  action: string;
  taskId?: string;
  strategyId?: string;
}

/** §3.4 生成报告（异步） */
export interface GenerateReportResp {
  taskId: string;
  reportId: string;
  status: string;
  period: string;
}

/** §1.4 报告列表行 */
export interface ReportListItemDto {
  reportId: string;
  period: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  taskId: string | null;
  generatedAt: string | null;
  createdAt: string;
}

/** §1.4 报告详情（content 为五段 Markdown；generating/failed 时为空） */
export interface ReportDetailDto extends ReportListItemDto {
  content: string | null;
  citations: Record<string, unknown>[];
}

export interface ReportListResp {
  items: ReportListItemDto[];
  total: number;
  page: number;
  pageSize: number;
}
