/**
 * 订单履约风险引擎（10 订单中心 FR-04/FR-05，纯函数、可单测）。
 *
 * 设计边界（10 §4 / §7）：
 * - 计划进度 plannedPct 一律按时间线性推算（planSource = linear_by_time，决策 A4），
 *   不由模型估计；落后比例按窗口天数折算 delayDays（决策 A5）。
 * - 状态（pending_payment/in_production/ready_to_ship/completed）由进度字段确定性推导（决策 A3），
 *   允许 shipping 由 true 回退为 false。
 * - 「原因表达与建议生成」属 AI 职责，本引擎给出确定性兜底文案与固定建议集合，
 *   Worker 的 order_monitor 图可用 AI 结果覆盖 reason/建议 label（数值绝不覆盖）。
 */

/** 订单履约进度四要素（10 §1.2 progress） */
export interface OrderProgress {
  poConfirmed: boolean;
  payment: boolean;
  productionPct: number;
  shipping: boolean;
}

/** 订单状态（10 §1.2 tab） */
export type OrderStatus = 'pending_payment' | 'in_production' | 'ready_to_ship' | 'completed';

/** 风险标记（10 §1.2 risk） */
export type OrderRiskLevel = 'normal' | 'at_risk';

/** 计划进度口径（10 §1.3 evidence.planSource，决策 A4 固定值） */
export const ORDER_RISK_PLAN_SOURCE = 'linear_by_time';

/** 落后阈值（百分点）：实际进度落后计划超过该值即判 at_risk（决策 A5） */
export const ORDER_RISK_THRESHOLD_PCT = 10;

/** 风险建议类型：internal 转内部任务 / customer 走客户沟通（10 §1.3） */
export type OrderRiskSuggestionType = 'internal' | 'customer';

export interface OrderRiskSuggestion {
  suggestionId: string;
  type: OrderRiskSuggestionType;
  label: string;
}

/** 固定建议集合（suggestionId 稳定，前端按 id 做 i18n，label 为服务端兜底文案） */
export const ORDER_RISK_SUGGESTIONS: readonly OrderRiskSuggestion[] = [
  { suggestionId: 'sg_1', type: 'internal', label: '联系生产负责人核实产能与排期' },
  { suggestionId: 'sg_2', type: 'internal', label: '调整生产计划并压缩关键路径' },
  { suggestionId: 'sg_3', type: 'customer', label: '准备延期沟通邮件并与客户确认新交期' },
];

export interface OrderRiskEvidence {
  plannedPct: number;
  actualPct: number;
  planSource: string;
  thresholdPct: number;
}

export interface OrderRiskAssessment {
  status: OrderRiskLevel;
  plannedPct: number;
  actualPct: number;
  /** 落后百分点（>=0） */
  lagPct: number;
  /** 按落后比例折算的预计延期天数（仅 at_risk 时 >0） */
  delayDays: number;
  /** 确定性兜底原因（AI 可覆盖表达） */
  reason: string;
  evidence: OrderRiskEvidence;
  suggestions: OrderRiskSuggestion[];
}

export interface OrderRiskInput {
  createdAt: Date;
  /** 约定交期 YYYY-MM-DD */
  deliveryDate: string;
  progress: OrderProgress;
  now?: Date;
}

const DAY_MS = 86_400_000;

/** 未开始履约的默认进度 */
export const EMPTY_ORDER_PROGRESS: OrderProgress = {
  poConfirmed: false,
  payment: false,
  productionPct: 0,
  shipping: false,
};

/** 进度字段归一化（DB 可空列 → 结构化 progress） */
export function normalizeOrderProgress(
  row:
    | {
        poConfirmed?: boolean | null;
        payment?: boolean | null;
        productionPct?: number | null;
        shipping?: boolean | null;
      }
    | null
    | undefined,
): OrderProgress {
  if (!row) return { ...EMPTY_ORDER_PROGRESS };
  return {
    poConfirmed: Boolean(row.poConfirmed),
    payment: Boolean(row.payment),
    productionPct: clampPct(row.productionPct ?? 0),
    shipping: Boolean(row.shipping),
  };
}

/** 状态推导（决策 A3）：shipping 优先，其次 payment / productionPct */
export function deriveOrderStatus(progress: OrderProgress): OrderStatus {
  if (progress.shipping) return 'completed';
  if (!progress.payment) return 'pending_payment';
  if (clampPct(progress.productionPct) >= 100) return 'ready_to_ship';
  return 'in_production';
}

/** 计划进度：创建日 → 约定交期的线性推进（0~100） */
export function computePlannedPct(createdAt: Date, deliveryDate: string, now: Date): number {
  const start = startOfUtcDay(createdAt);
  const end = toUtcDay(deliveryDate);
  if (end === null) return 100;
  if (end <= start) {
    // 交期缺失或早于创建日：已到交期视作计划满额，否则视作未启动
    return startOfUtcDay(now) >= end ? 100 : 0;
  }
  const window = (end - start) / DAY_MS;
  const elapsed = (startOfUtcDay(now) - start) / DAY_MS;
  return clampPct(Math.round((elapsed / window) * 100));
}

/** 实际进度：shipping 视作 100%，否则取生产完成度 */
export function computeActualPct(progress: OrderProgress): number {
  if (progress.shipping) return 100;
  return clampPct(progress.productionPct);
}

/**
 * 风险判定：
 * - 落后（lagPct = plannedPct - actualPct）超过阈值 → at_risk；
 * - delayDays 按落后比例 × 窗口天数折算（至少 1 天）；
 * - 无证据（lagPct <= 阈值）→ normal，delayDays = 0、无建议。
 */
export function computeOrderRisk(input: OrderRiskInput): OrderRiskAssessment {
  const now = input.now ?? new Date();
  const plannedPct = computePlannedPct(input.createdAt, input.deliveryDate, now);
  const actualPct = computeActualPct(input.progress);
  const lagPct = Math.max(0, plannedPct - actualPct);
  const atRisk = lagPct > ORDER_RISK_THRESHOLD_PCT;
  const evidence: OrderRiskEvidence = {
    plannedPct,
    actualPct,
    planSource: ORDER_RISK_PLAN_SOURCE,
    thresholdPct: ORDER_RISK_THRESHOLD_PCT,
  };

  if (!atRisk) {
    return {
      status: 'normal',
      plannedPct,
      actualPct,
      lagPct,
      delayDays: 0,
      reason: '',
      evidence,
      suggestions: [],
    };
  }

  const windowDays = windowDaysBetween(input.createdAt, input.deliveryDate);
  const delayDays = Math.max(1, Math.ceil((lagPct / 100) * windowDays));

  return {
    status: 'at_risk',
    plannedPct,
    actualPct,
    lagPct,
    delayDays,
    reason: `履约进度 ${actualPct}% 落后计划 ${plannedPct}%，预计延期 ${delayDays} 天`,
    evidence,
    suggestions: ORDER_RISK_SUGGESTIONS.map((item) => ({ ...item })),
  };
}

/** 创建日 → 交期的窗口天数（>=1，交期缺失按 1 天处理） */
function windowDaysBetween(createdAt: Date, deliveryDate: string): number {
  const start = startOfUtcDay(createdAt);
  const end = toUtcDay(deliveryDate);
  if (end === null || end <= start) return 1;
  return Math.max(1, Math.round((end - start) / DAY_MS));
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** 'YYYY-MM-DD' → UTC 零点毫秒值；非法输入返回 null */
function toUtcDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day);
}
