import { describe, expect, it } from 'vitest';
import {
  BizException,
  COST_ITEMS,
  aggregateCostBreakdown,
  assertProfitFloor,
  buildExchangeRateSnapshot,
  buildNegotiationLadder,
  buildPricingReasons,
  computeProfitMarginPct,
  computeQuoteProfit,
  computeUnitCosts,
  mergeCostSnapshot,
  scaledToAmount,
  sumCostBreakdown,
  sumCostSnapshot,
} from '../src/index.js';

describe('computeUnitCosts（五项成本，P1-X-10）', () => {
  it('按缺省规则核算运费/保费/税费/汇兑', () => {
    const snapshot = computeUnitCosts({ unitPrice: '12.50', purchaseCost: '8.00' });
    expect(snapshot).toEqual({
      purchase: 8,
      freight: 0.8,
      insurance: 0.1,
      tax: 0.3,
      fx: 0.2,
    });
    expect(sumCostSnapshot(snapshot)).toBe('9.40');
  });

  it('支持固定单位金额与行级覆盖', () => {
    const snapshot = computeUnitCosts({
      unitPrice: '12.50',
      purchaseCost: '8.00',
      rules: { freight: { fixed: '1.00' }, tax: { pct: 0 } },
    });
    expect(snapshot.freight).toBe(1);
    expect(snapshot.tax).toBe(0);
    expect(snapshot.insurance).toBe(0.1);
  });

  it('未启用的成本项记 0', () => {
    const snapshot = computeUnitCosts({
      unitPrice: '12.50',
      purchaseCost: '8.00',
      enabledCostItems: [COST_ITEMS.PURCHASE, COST_ITEMS.FREIGHT],
    });
    expect(snapshot).toEqual({ purchase: 8, freight: 0.8, insurance: 0, tax: 0, fx: 0 });
  });
});

describe('computeProfitMarginPct（利润率，P1-X-11）', () => {
  it('按 (售价-成本)/售价 计算', () => {
    expect(computeProfitMarginPct('12.50', '9.40')).toBe('24.80');
    expect(computeProfitMarginPct('100.00', '80.00')).toBe('20.00');
  });

  it('亏损返回负利润率，售价非正返回 0.00', () => {
    expect(computeProfitMarginPct('12.50', '15.00')).toBe('-20.00');
    expect(computeProfitMarginPct('0', '9.40')).toBe('0.00');
  });
});

describe('assertProfitFloor（利润红线 100% 拦截，P1-X-11）', () => {
  it('达到红线不拦截', () => {
    expect(() =>
      assertProfitFloor({ profitMarginPct: '24.80', profitFloorPct: '20.00' }),
    ).not.toThrow();
    expect(() =>
      assertProfitFloor({ profitMarginPct: '20.00', profitFloorPct: '20.00' }),
    ).not.toThrow();
  });

  it('低于红线抛出 42201', () => {
    try {
      assertProfitFloor({ profitMarginPct: '15.00', profitFloorPct: '20.00' });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(BizException);
      expect((error as BizException).code).toBe(42201);
    }
  });
});

describe('buildExchangeRateSnapshot（汇率快照，P1-X-12）', () => {
  it('定标 8 位并缺省 source=manual', () => {
    expect(buildExchangeRateSnapshot({ rate: '7.123456789', date: '2026-09-13' })).toEqual({
      rate: '7.12345679',
      date: '2026-09-13',
      source: 'manual',
    });
  });

  it('拒绝非法日期', () => {
    expect(() => buildExchangeRateSnapshot({ rate: '7.1', date: '2026/09/13' })).toThrow(
      BizException,
    );
  });
});

describe('mergeCostSnapshot / aggregateCostBreakdown（成本快照，P1-X-13）', () => {
  const line = () => computeUnitCosts({ unitPrice: '12.50', purchaseCost: '8.00' });

  it('人工覆盖优先，其余取引擎值', () => {
    const merged = mergeCostSnapshot(line(), { purchase: 8.5 });
    expect(merged).toEqual({ purchase: 8.5, freight: 0.8, insurance: 0.1, tax: 0.3, fx: 0.2 });
  });

  it('按行数量汇总为 costBreakdown', () => {
    const breakdown = aggregateCostBreakdown([
      { quantity: 100, costSnapshot: line() },
      { quantity: 50, costSnapshot: line() },
    ]);
    expect(breakdown).toEqual({
      purchase: '1200.00',
      freight: '120.00',
      insurance: '15.00',
      tax: '45.00',
      fx: '30.00',
    });
    expect(sumCostBreakdown(breakdown)).toBe('1410.00');
  });

  it('拒绝非法数量', () => {
    expect(() => aggregateCostBreakdown([{ quantity: 0, costSnapshot: line() }])).toThrow(
      BizException,
    );
  });

  it('computeQuoteProfit 汇总报价毛利', () => {
    const breakdown = aggregateCostBreakdown([
      { quantity: 100, costSnapshot: line() },
      { quantity: 50, costSnapshot: line() },
    ]);
    expect(computeQuoteProfit({ totalAmount: '1875.00', costBreakdown: breakdown })).toEqual({
      totalCost: '1410.00',
      profitAmount: '465.00',
      profitMarginPct: '24.80',
    });
  });
});

describe('buildPricingReasons（可解释 reasons，P1-X-14）', () => {
  it('输出数量/评分/历史三类证据', () => {
    const reasons = buildPricingReasons({
      quantity: 500,
      matchedTier: { minQty: 500, unitPrice: '11.80' },
      customerScore: 86,
      history: { minPrice: '11.50', maxPrice: '12.20', windowDays: 90, sampleSize: 12 },
    });
    expect(reasons.map((item) => item.source)).toEqual(['pricing_engine', 'crm', 'history']);
    expect(reasons[0]?.evidence).toContain('500');
  });

  it('无证据时不产出条目', () => {
    expect(buildPricingReasons({ quantity: 10 })).toEqual([]);
  });
});

describe('buildNegotiationLadder（议价梯度，A2 只用）', () => {
  it('按折扣梯度逐轮给出建议价', () => {
    expect(buildNegotiationLadder('12.50', [3, 2, 1])).toEqual([
      { round: 1, discountPct: 3, suggestedUnitPrice: '12.1250' },
      { round: 2, discountPct: 2, suggestedUnitPrice: '11.8750' },
      { round: 3, discountPct: 1, suggestedUnitPrice: '11.7500' },
    ]);
  });
});

describe('scaledToAmount', () => {
  it('缩放整数还原为定标金额', () => {
    expect(scaledToAmount(141000n, 2)).toBe('1410.00');
    expect(scaledToAmount(-2000n, 2)).toBe('-20.00');
    expect(scaledToAmount(5n, 0)).toBe('5');
  });
});
