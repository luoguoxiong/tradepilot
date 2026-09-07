import { describe, expect, it } from 'vitest';
import { crossedBudget } from '../src/index.js';

/**
 * LLM 预算跨阈值判定单测（16 FR-10 MVP 增量口径 / M3-15）：
 * 仅「前值 ≤ 预算 < 后值」（当月累计首次越界）上报一次，持续超限不重复告警；不熔断。
 */

describe('crossedBudget（16 FR-10 MVP 增量口径 / M3-15）', () => {
  it('首次越界（前值在预算内，后值超限）→ true', () => {
    expect(crossedBudget(0, 1001, 1000)).toBe(true);
  });

  it('恰好等于预算（后值 == 预算）不算超限 → false', () => {
    expect(crossedBudget(0, 1000, 1000)).toBe(false);
  });

  it('持续超限（前值已在预算外）不再重复告警 → false', () => {
    expect(crossedBudget(1001, 1200, 1000)).toBe(false);
  });

  it('仍低于预算 → false', () => {
    expect(crossedBudget(0, 800, 1000)).toBe(false);
  });

  it('预算为 0：首笔成本 >0 即越界告警，之后不重复', () => {
    expect(crossedBudget(0, 0.01, 0)).toBe(true);
    expect(crossedBudget(0.01, 0.02, 0)).toBe(false);
  });

  it('负数/异常前值不触发（防御）', () => {
    expect(crossedBudget(-5, 900, 1000)).toBe(false);
  });
});
