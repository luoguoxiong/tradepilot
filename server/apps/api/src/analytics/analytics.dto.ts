/**
 * 15 数据中心 DTO（页面级字段与接口文档 15 §1/§3，P1）。
 *
 * 公共筛选（15 §1.1）：period（this_week/this_month/custom，custom 附 startDate/endDate）
 * + country（市场，默认 all）+ employeeId（AI 员工，默认 all）+ scope（数据权限，缺省取角色上限）。
 * 下钻 metric 枚举与 `@tradepilot/core` ANALYTICS_METRIC 一一对应（口径单一实现点）。
 */
import { z } from 'zod';
import type { AnalyticsMetric } from '@tradepilot/core';

export const ANALYTICS_PERIODS = ['this_week', 'this_month', 'custom'] as const;
export type AnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number];

/** 下钻 metric 白名单（接口 15 §3.4；satisfies 约束保证与 core 枚举同源） */
export const DRILLDOWN_METRIC_VALUES = [
  'new_customers',
  'inquiries',
  'new_quotes',
  'deals_closed',
  'found_customers',
  'replied_emails',
  'saved_hours',
  'promoted_inquiries',
] as const satisfies readonly AnalyticsMetric[];

export type DrilldownMetric = (typeof DRILLDOWN_METRIC_VALUES)[number];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const dateSchema = z.string().trim().regex(DATE_PATTERN, '日期格式应为 YYYY-MM-DD');

/** §1.1 公共筛选基座（不含区间校验，便于 extend 复用） */
export const analyticsFilterBaseSchema = z.object({
  period: z.enum(ANALYTICS_PERIODS).default('this_week'),
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  /** 市场筛选（ISO 3166-1 alpha-2）；all = 全部 */
  country: z.string().trim().min(1).max(16).default('all'),
  /** AI 员工筛选（emp_*）；all = 全部 */
  employeeId: z.string().trim().min(1).max(64).default('all'),
  /** 数据权限（00 §4.4）；越权值由 resolveScope 收敛到角色上限 */
  scope: z.enum(['self', 'team', 'all']).optional(),
});

export type AnalyticsFilterDto = z.infer<typeof analyticsFilterBaseSchema>;

interface PeriodRangeFields {
  period: AnalyticsPeriod;
  startDate?: string;
  endDate?: string;
}

/** custom 区间必填 startDate/endDate 且 startDate ≤ endDate（15 §1.1） */
function checkPeriodRange(value: PeriodRangeFields, ctx: z.RefinementCtx): void {
  if (value.period !== 'custom') return;
  if (!value.startDate) {
    ctx.addIssue({ code: 'custom', path: ['startDate'], message: '自定义区间需提供 startDate' });
  }
  if (!value.endDate) {
    ctx.addIssue({ code: 'custom', path: ['endDate'], message: '自定义区间需提供 endDate' });
  }
  if (value.startDate && value.endDate && value.startDate > value.endDate) {
    ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'endDate 不能早于 startDate' });
  }
}

/** 趋势 / 分布 / 贡献 / 导出共用筛选 */
export const analyticsFilterSchema = analyticsFilterBaseSchema.superRefine(checkPeriodRange);

/** §3.4 下钻：公共筛选 + metric 枚举 + 分页 */
export const drilldownQuerySchema = analyticsFilterBaseSchema
  .extend({
    metric: z.enum(DRILLDOWN_METRIC_VALUES),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .superRefine(checkPeriodRange);

export type DrilldownQueryDto = z.infer<typeof drilldownQuerySchema>;

// ===== 响应契约（15 §3） =====

/** §1.2 客户增长趋势点（date 为 org 时区当地日） */
export interface TrendPointDto {
  date: string;
  newCustomers: number;
  newInquiries: number;
  newQuotes: number;
}

/** §3.1 GET /analytics/customer-trend */
export interface CustomerTrendResp {
  trend: TrendPointDto[];
}

/** §1.3 市场分布行 */
export interface MarketRowDto {
  country: string;
  customerCount: number;
  pct: number;
}

/** §3.2 GET /analytics/market-distribution */
export interface MarketDistributionResp {
  markets: MarketRowDto[];
}

/** §3.3 GET /analytics/ai-contribution */
export interface AiContributionResp {
  foundCustomers: number;
  repliedEmails: number;
  savedHours: number;
  promotedInquiries: number;
  /** 估算口径说明（15 §4 红线：必须随接口返回并页面标注） */
  caliberNote: string;
}

/** §3.4 下钻明细行（统一形态，供明细抽屉渲染 + 口径复算） */
export interface DrilldownItemDto {
  id: string;
  /** 明细类型：customer / conversation / quotation / message / found_customer / replied_email / follow_up */
  type: string;
  title: string;
  subtitle: string | null;
  country: string | null;
  /** 归属人（AI 员工名或业务员名） */
  ownerName: string | null;
  /** 数值列（报价金额 / saved_hours 的分钟数） */
  amount: string | null;
  /** 数值单位（币种 / MIN） */
  currency: string | null;
  occurredAt: string;
}

export interface DrilldownResp {
  metric: DrilldownMetric;
  total: number;
  page: number;
  pageSize: number;
  items: DrilldownItemDto[];
}

/** 导出文件名与内容 */
export interface AnalyticsExportResult {
  filename: string;
  buffer: Buffer;
}
