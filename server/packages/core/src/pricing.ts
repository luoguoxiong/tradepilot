import { ErrorCode } from './error-codes.js';
import { BizException } from './errors.js';
import { amountToScaledBigInt, normalizeAmount } from './money.js';

/**
 * 定价引擎（09 §7.1 权威口径 / P1-X-10~14）。
 *
 * 纯函数、无 I/O：由调用方（09 报价 / 10 订单）从 16「产品与报价规则」读取配置后传入。
 * 红线：价格数字不允许 LLM 自由生成——本引擎为唯一结构化定价来源，LLM 仅表达 reasons 文案。
 *
 * 五项成本（`cost_snapshot`）：
 * - `purchase` 采购 = `product.cost_price`（原币种按报价时点汇率换算后传入）；
 * - `freight` 运费 / `insurance` 保费 / `tax` 税费 = 按 16 规则（售价百分比 / 固定单位金额）；
 * - `fx` 汇兑 = 按报价时点汇率产生的汇兑成本。
 *
 * 汇率快照为 `{ rate, date, source }` 三元组（MVP `source='manual'`，成交核算以快照为准，不随市价变动）。
 */

/** 五项成本项键（ER 01 §2.6 cost_items；中文对应：采购/运费/保费/税费/汇兑） */
export const COST_ITEMS = {
  PURCHASE: 'purchase',
  FREIGHT: 'freight',
  INSURANCE: 'insurance',
  TAX: 'tax',
  FX: 'fx',
} as const;
export type CostItemKey = (typeof COST_ITEMS)[keyof typeof COST_ITEMS];

/** 全部成本项（顺序即 cost_items 默认顺序） */
export const COST_ITEM_KEYS: readonly CostItemKey[] = [
  COST_ITEMS.PURCHASE,
  COST_ITEMS.FREIGHT,
  COST_ITEMS.INSURANCE,
  COST_ITEMS.TAX,
  COST_ITEMS.FX,
];

/** 行级成本快照（jsonb，`quotation_item.cost_snapshot` / `sales_order_item.cost_snapshot`） */
export type CostSnapshot = Partial<Record<CostItemKey, number>>;

/** 报价/订单级成本汇总（AI 定价建议 `costBreakdown`，金额字符串） */
export type CostBreakdown = Record<CostItemKey, string>;

/** 汇率快照三元组（ER 07 §2.1，MVP `source='manual'`） */
export interface ExchangeRateSnapshot {
  /** 汇率时点值（定标 8 位） */
  rate: string;
  /** 汇率日期 `YYYY-MM-DD` */
  date: string;
  /** 汇率源（MVP 固定 `manual`） */
  source: string;
}

/** 单项成本规则：按售价百分比 / 固定单位金额（09 §7.1「单价百分比 / 固定费率」） */
export interface CostRateRule {
  /** 占售价百分比（%），如 6.4 表示售价 6.4% */
  pct?: number;
  /** 固定单位金额（报价币种，字符串十进制） */
  fixed?: string;
}

/** 成本规则覆盖（16 FR-07 未配置费率时回落 DEFAULT_COST_RULES） */
export interface PricingCostRules {
  freight?: CostRateRule;
  insurance?: CostRateRule;
  tax?: CostRateRule;
  fx?: CostRateRule;
}

/**
 * 缺省成本规则基线（16 FR-07 未配置费率时兜底）：
 * 与接口文档 09 §3.2 示例比例一致——运费 6.4% / 保费 0.8% / 税费 2.4% / 汇兑 1.6%。
 * 生产环境由 16 报价规则覆盖（purchase 恒取产品采购成本，不受此处影响）。
 */
export const DEFAULT_COST_RULES: Required<PricingCostRules> = {
  freight: { pct: 6.4 },
  insurance: { pct: 0.8 },
  tax: { pct: 2.4 },
  fx: { pct: 1.6 },
};

/** 单行成本核算输入 */
export interface LineCostInput {
  /** 报价单价（报价币种） */
  unitPrice: string;
  /** 采购成本（报价币种；调用方按报价时点汇率换算后传入） */
  purchaseCost: string;
  /** 行级规则覆盖（缺省回落 DEFAULT_COST_RULES） */
  rules?: PricingCostRules;
  /** 启用的成本项（16 FR-07 `costItems`）；缺省五项全启用，未启用项记 0 */
  enabledCostItems?: readonly CostItemKey[];
}

/** 定价推荐原因（结构对齐 @tradepilot/shared InsightReason：text / evidence / source） */
export interface PricingReason {
  text: string;
  evidence: string;
  source: string;
}

/** 定标十进制字符串 → BigInt（scale 位），用于无误差汇总 */
export function scaledToAmount(scaled: bigint, scale = 2): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const text = abs.toString().padStart(scale + 1, '0');
  const intPart = text.slice(0, text.length - scale) || '0';
  const fracPart = scale > 0 ? `.${text.slice(text.length - scale)}` : '';
  return `${negative ? '-' : ''}${intPart}${fracPart}`;
}

/** 按规则求单项成本（占售价百分比优先于固定金额；均为空 → 0） */
function resolveCost(rule: CostRateRule | undefined, unitPrice: string): number {
  if (!rule) {
    return 0;
  }
  if (rule.fixed !== undefined) {
    return Number(normalizeAmount(rule.fixed, 2));
  }
  if (rule.pct !== undefined) {
    return Number(normalizeAmount((Number(unitPrice) * rule.pct) / 100, 2));
  }
  return 0;
}

/** 合并行级规则与缺省规则 */
function mergeRules(rules?: PricingCostRules): Required<PricingCostRules> {
  return {
    freight: rules?.freight ?? DEFAULT_COST_RULES.freight,
    insurance: rules?.insurance ?? DEFAULT_COST_RULES.insurance,
    tax: rules?.tax ?? DEFAULT_COST_RULES.tax,
    fx: rules?.fx ?? DEFAULT_COST_RULES.fx,
  };
}

/**
 * 五项成本核算（P1-X-10）：返回单件成本快照（定标 2 位）。
 * `purchase` 恒取入参采购成本；其余四项按规则核算，未启用成本项记 0。
 */
export function computeUnitCosts(input: LineCostInput): CostSnapshot {
  const unitPrice = normalizeAmount(input.unitPrice, 4);
  const purchase = normalizeAmount(input.purchaseCost, 2);
  const rules = mergeRules(input.rules);
  const enabled = input.enabledCostItems ?? COST_ITEM_KEYS;
  const on = (key: CostItemKey): boolean => enabled.includes(key);

  return {
    purchase: on(COST_ITEMS.PURCHASE) ? Number(purchase) : 0,
    freight: on(COST_ITEMS.FREIGHT) ? resolveCost(rules.freight, unitPrice) : 0,
    insurance: on(COST_ITEMS.INSURANCE) ? resolveCost(rules.insurance, unitPrice) : 0,
    tax: on(COST_ITEMS.TAX) ? resolveCost(rules.tax, unitPrice) : 0,
    fx: on(COST_ITEMS.FX) ? resolveCost(rules.fx, unitPrice) : 0,
  };
}

/** 单件总成本（五项求和，定标 2 位字符串） */
export function sumCostSnapshot(snapshot: CostSnapshot): string {
  const total = COST_ITEM_KEYS.reduce(
    (acc, key) => acc + amountToScaledBigInt(String(snapshot[key] ?? 0), 2),
    0n,
  );
  return scaledToAmount(total, 2);
}

/**
 * 利润率核算（P1-X-11）：`(unitPrice - unitCost) / unitPrice × 100`，定标 2 位。
 * `unitPrice <= 0` 时返回 `"0.00"`（避免除零）。
 */
export function computeProfitMarginPct(unitPrice: string, unitCost: string): string {
  const price = amountToScaledBigInt(normalizeAmount(unitPrice, 4), 4);
  if (price <= 0n) {
    return '0.00';
  }
  const cost = amountToScaledBigInt(normalizeAmount(unitCost, 2), 4);
  // (price - cost) / price × 100，结果定标 2 位（百分数）
  const numerator = (price - cost) * 10_000n;
  const rounded =
    numerator >= 0n ? (numerator + price / 2n) / price : (numerator - price / 2n) / price;
  return scaledToAmount(rounded, 2);
}

/**
 * 利润红线校验（P1-X-11，09 §3.2）：低于 `profitFloorPct` → `42201`（100% 拦截，不可绕过）。
 */
export function assertProfitFloor(input: {
  profitMarginPct: string | number;
  profitFloorPct: string | number;
}): void {
  const margin = Number(normalizeAmount(input.profitMarginPct, 2));
  const floor = Number(normalizeAmount(input.profitFloorPct, 2));
  if (margin < floor) {
    throw new BizException(
      ErrorCode.BIZ_VALIDATION,
      `利润率 ${margin.toFixed(2)}% 低于利润红线 ${floor.toFixed(2)}%，已拦截`,
    );
  }
}

/** 汇率快照三元组（P1-X-12）：`rate` 定标 8 位；缺省 `source='manual'` */
export function buildExchangeRateSnapshot(input: {
  rate: string | number;
  date: string;
  source?: string;
}): ExchangeRateSnapshot {
  const rate = normalizeAmount(input.rate, 8);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new BizException(ErrorCode.BAD_REQUEST, `汇率日期格式应为 YYYY-MM-DD: ${input.date}`);
  }
  const source = (input.source ?? 'manual').trim();
  if (!source) {
    throw new BizException(ErrorCode.BAD_REQUEST, '汇率源不能为空');
  }
  return { rate, date: input.date, source };
}

/** 行级快照固化（P1-X-13）：引擎结果与人工覆盖按项合并，覆盖优先（draft 可改） */
export function mergeCostSnapshot(
  engine: CostSnapshot,
  override?: CostSnapshot | null,
): CostSnapshot {
  if (!override) {
    return { ...engine };
  }
  const merged: CostSnapshot = { ...engine };
  for (const key of COST_ITEM_KEYS) {
    if (override[key] !== undefined) {
      merged[key] = Number(normalizeAmount(override[key], 2));
    }
  }
  return merged;
}

/** 报价级成本汇总（P1-X-13）：各行 `cost_snapshot` × 数量求和 → `costBreakdown`（金额字符串） */
export function aggregateCostBreakdown(
  lines: readonly { quantity: number; costSnapshot: CostSnapshot }[],
): CostBreakdown {
  const totals = new Map<CostItemKey, bigint>(COST_ITEM_KEYS.map((key) => [key, 0n]));
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new BizException(ErrorCode.BAD_REQUEST, `明细数量必须为正整数: ${line.quantity}`);
    }
    for (const key of COST_ITEM_KEYS) {
      const unit = amountToScaledBigInt(String(line.costSnapshot[key] ?? 0), 2);
      totals.set(key, (totals.get(key) ?? 0n) + unit * BigInt(line.quantity));
    }
  }
  return {
    purchase: scaledToAmount(totals.get(COST_ITEMS.PURCHASE) ?? 0n, 2),
    freight: scaledToAmount(totals.get(COST_ITEMS.FREIGHT) ?? 0n, 2),
    insurance: scaledToAmount(totals.get(COST_ITEMS.INSURANCE) ?? 0n, 2),
    tax: scaledToAmount(totals.get(COST_ITEMS.TAX) ?? 0n, 2),
    fx: scaledToAmount(totals.get(COST_ITEMS.FX) ?? 0n, 2),
  };
}

/** 报价级成本总额（五项汇总求和） */
export function sumCostBreakdown(breakdown: CostBreakdown): string {
  const total = COST_ITEM_KEYS.reduce(
    (acc, key) => acc + amountToScaledBigInt(breakdown[key], 2),
    0n,
  );
  return scaledToAmount(total, 2);
}

/**
 * 报价级利润率（P1-X-11）：`(totalAmount - totalCost) / totalAmount × 100`，定标 2 位。
 * `totalAmount <= 0` 时返回 `"0.00"`。
 */
export function computeQuoteProfit(input: { totalAmount: string; costBreakdown: CostBreakdown }): {
  totalCost: string;
  profitAmount: string;
  profitMarginPct: string;
} {
  const totalAmount = amountToScaledBigInt(normalizeAmount(input.totalAmount, 2), 2);
  const totalCost = amountToScaledBigInt(sumCostBreakdown(input.costBreakdown), 2);
  const profit = totalAmount - totalCost;
  const numerator = profit * 10_000n;
  const profitMarginPct =
    totalAmount <= 0n
      ? '0.00'
      : scaledToAmount(
          numerator >= 0n
            ? (numerator + totalAmount / 2n) / totalAmount
            : (numerator - totalAmount / 2n) / totalAmount,
          2,
        );
  return {
    totalCost: scaledToAmount(totalCost, 2),
    profitAmount: scaledToAmount(profit, 2),
    profitMarginPct,
  };
}

/**
 * 推荐原因 `reasons[]`（P1-X-14）：数量档位 / 客户评分 / 历史成交价，结构对齐 Insight Schema。
 * 无证据的条目一律不产出（可解释红线），排序稳定（数量 → 评分 → 历史）。
 */
export function buildPricingReasons(input: {
  quantity: number;
  /** 命中的价格档（产品价格档），可选 */
  matchedTier?: { minQty: number; unitPrice: string };
  /** 客户评分 0~100，可选 */
  customerScore?: number;
  /** 近 windowDays 天同产品历史成交价区间，可选 */
  history?: { minPrice: string; maxPrice: string; windowDays: number; sampleSize?: number };
}): PricingReason[] {
  const reasons: PricingReason[] = [];

  if (input.matchedTier) {
    reasons.push({
      text: '采购数量较大',
      evidence: `${formatInt(input.quantity)} 件 ≥ 价格档 ${formatInt(input.matchedTier.minQty)}+（参考单价 $${normalizeAmount(input.matchedTier.unitPrice, 2)}）`,
      source: 'pricing_engine',
    });
  }

  if (input.customerScore !== undefined) {
    reasons.push({
      text: input.customerScore >= 80 ? '客户评分高' : '客户评分中上',
      evidence: `Score ${input.customerScore}`,
      source: 'crm',
    });
  }

  if (input.history) {
    const sample = input.history.sampleSize ? `，样本 ${input.history.sampleSize} 单` : '';
    reasons.push({
      text: '历史成交价格在合理范围',
      evidence: `近 ${input.history.windowDays} 天同产品成交 $${normalizeAmount(input.history.minPrice, 2)}~$${normalizeAmount(input.history.maxPrice, 2)}${sample}`,
      source: 'history',
    });
  }

  return reasons;
}

/** 议价梯度只读建议（09 §4 / A2）：按 `discountLadder` 逐轮递减让价；**永不返回底价/剩余底线** */
export function buildNegotiationLadder(
  baseUnitPrice: string,
  ladder: readonly number[],
): { round: number; discountPct: number; suggestedUnitPrice: string }[] {
  const base = normalizeAmount(baseUnitPrice, 4);
  let cumulative = 0n;
  return ladder.map((discountPct, index) => {
    cumulative += amountToScaledBigInt(String(discountPct), 2);
    const price = (amountToScaledBigInt(base, 4) * (10_000n - cumulative)) / 10_000n;
    return {
      round: index + 1,
      discountPct,
      suggestedUnitPrice: scaledToAmount(price, 4),
    };
  });
}

/** 千分位整数（reasons 证据文案） */
function formatInt(value: number): string {
  return value.toLocaleString('en-US');
}
