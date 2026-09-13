/**
 * 分析指标口径与预聚合常量（P1-X-40~43，产品需求 15 §7 / ER 08 §2.5）。
 *
 * 单一实现点：定时 ETL（worker `scheduler/analytics-etl`）与数据中心接口（15 §3，S4）
 * 共用本模块，保证「统计口径必须可下钻验证」（15 §4 红线）——同一指标的计数/估算口径
 * 不出现第二份实现。全部为纯函数与常量，不做 IO。
 */

/** 预聚合维度兜底值（ER 08 §2.5：`country` / `employee_id` DEFAULT `'ALL'`） */
export const STAT_DIMENSION_ALL = 'ALL';

/** 下钻 metric 枚举（接口 15 §3.4；与预聚合指标一一对应） */
export const ANALYTICS_METRIC = {
  NEW_CUSTOMERS: 'new_customers',
  INQUIRIES: 'inquiries',
  NEW_QUOTES: 'new_quotes',
  DEALS_CLOSED: 'deals_closed',
  FOUND_CUSTOMERS: 'found_customers',
  REPLIED_EMAILS: 'replied_emails',
  SAVED_HOURS: 'saved_hours',
  PROMOTED_INQUIRIES: 'promoted_inquiries',
} as const;

export type AnalyticsMetric = (typeof ANALYTICS_METRIC)[keyof typeof ANALYTICS_METRIC];

/** 全部 metric（DTO 白名单校验用） */
export const ANALYTICS_METRIC_LIST: readonly string[] = Object.values(ANALYTICS_METRIC);

/**
 * 单动作人工基准时长（分钟）——15 §7「MVP 内置基准常量」：
 * 获客筛选 10min/客户、邮件撰写 15min/封、跟进动作 5min/次（基准可配置列后续增强）。
 */
export const SAVED_HOURS_BASELINE_MINUTES = {
  /** 获客筛选：10min/客户 */
  foundCustomer: 10,
  /** 邮件撰写：15min/封 */
  email: 15,
  /** 跟进动作：5min/次 */
  followUp: 5,
} as const;

/** 促成询盘归因窗口（天）——15 §7 固定 14；多触点归因列后续 */
export const PROMOTED_INQUIRY_WINDOW_DAYS = 14;

/** 归因窗口毫秒数（纯函数换算用） */
export const PROMOTED_INQUIRY_WINDOW_MS = PROMOTED_INQUIRY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** AI 自动完成动作计数（savedHours 估算输入） */
export interface AiActionCounts {
  /** 获客筛选动作数（AI 找到客户并转入 CRM） */
  foundCustomers: number;
  /** 邮件撰写动作数（AI 外联邮件发送） */
  repliedEmails: number;
  /** 跟进动作数（自动跟进触达） */
  followUpActions: number;
}

/**
 * AI 节省工时估算 = Σ(动作数 × 人工基准分钟) / 60，保留 1 位小数
 * （对齐 ER 08 §2.5 `saved_hours numeric(10,1)`；15 §4 页面必须标注估算口径）。
 */
export function computeSavedHours(counts: AiActionCounts): number {
  const minutes =
    counts.foundCustomers * SAVED_HOURS_BASELINE_MINUTES.foundCustomer +
    counts.repliedEmails * SAVED_HOURS_BASELINE_MINUTES.email +
    counts.followUpActions * SAVED_HOURS_BASELINE_MINUTES.followUp;
  return Math.round((minutes / 60) * 10) / 10;
}

/**
 * 指标口径说明（15 §3.3 / §4：`savedHours` 为估算指标，`caliberNote` 必须随接口返回并页面标注）。
 */
export const ANALYTICS_CALIBER_NOTE =
  '节省工时=AI 自动完成动作数 × 单动作人工基准时长（估算：获客筛选 10min/客户、' +
  '邮件撰写 15min/封、跟进 5min/次）；促成询盘=AI 外联后 14 天内客户首条来信（最后触点归因）';

/** AI 外联触点（归因用：某 AI 员工在某个时点发出的外联邮件） */
export interface OutboundTouch {
  /** AI 员工 id（emp_） */
  employeeId: string;
  /** 外联时点（message.sent_at） */
  at: Date;
}

/**
 * 归因窗口判定（15 §7）：外联触点须早于或等于询盘时点，且间隔不超过 windowDays 天。
 * 含边界（同为窗口端点即算命中）。
 */
export function isWithinAttributionWindow(
  outboundAt: Date,
  inquiryAt: Date,
  windowDays: number = PROMOTED_INQUIRY_WINDOW_DAYS,
): boolean {
  const deltaMs = inquiryAt.getTime() - outboundAt.getTime();
  return deltaMs >= 0 && deltaMs <= windowDays * 24 * 60 * 60 * 1000;
}

/**
 * 最后触点归因（15 §7 简化口径）：在归因窗口内取 `at` 最大的外联触点；
 * 窗口内无触点返回 `null`（该询盘不计入 `promotedInquiries`）。
 */
export function pickLastTouch(
  touches: readonly OutboundTouch[],
  inquiryAt: Date,
  windowDays: number = PROMOTED_INQUIRY_WINDOW_DAYS,
): OutboundTouch | null {
  let best: OutboundTouch | null = null;
  for (const touch of touches) {
    if (!isWithinAttributionWindow(touch.at, inquiryAt, windowDays)) {
      continue;
    }
    if (best === null || touch.at.getTime() > best.at.getTime()) {
      best = touch;
    }
  }
  return best;
}
