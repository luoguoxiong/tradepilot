import { describe, expect, it } from 'vitest';
import { fuseRrf, rrfScore, sceneCategories, sceneTopK, RRF_K } from '../src/rrf.js';

describe('rrfScore', () => {
  it('rank 越靠前分数越高，rank=1 最大', () => {
    expect(rrfScore(1)).toBeGreaterThan(rrfScore(2));
    expect(rrfScore(1)).toBeCloseTo(1 / (RRF_K + 1), 10);
  });
});

describe('fuseRrf', () => {
  it('多路同 id 求和，按分数降序（并列按 id 字典序稳定）', () => {
    const vec = [{ id: 'a', rank: 1 }, { id: 'b', rank: 2 }];
    const fts = [{ id: 'a', rank: 3 }, { id: 'b', rank: 1 }];
    const fused = fuseRrf([vec, fts]);
    // b：1/(61)+1/(61) > a：1/(61)+1/(63)
    expect(fused[0].id).toBe('b');
    expect(fused[0].score).toBeGreaterThan(fused[1].score);
  });

  it('仅一路命中也参与排序', () => {
    const fused = fuseRrf([[{ id: 'x', rank: 5 }]]);
    expect(fused).toHaveLength(1);
    expect(fused[0].id).toBe('x');
  });

  it('空入参 → 空结果', () => {
    expect(fuseRrf([])).toEqual([]);
  });
});

describe('场景差异化（07 §4.1）', () => {
  it('lead_match 偏 product', () => {
    expect(sceneCategories('lead_match')).toEqual(['product']);
  });
  it('sales_reply 覆盖 product/faq/sales/company', () => {
    expect(sceneCategories('sales_reply')).toEqual([
      'product',
      'faq',
      'sales',
      'company',
    ]);
  });
  it('business_analysis 不限类目（全类目）', () => {
    expect(sceneCategories('business_analysis')).toBeNull();
  });
  it('business_analysis Top-K 提至 10', () => {
    expect(sceneTopK('business_analysis', 5)).toBe(10);
    expect(sceneTopK('lead_match', 5)).toBe(5);
    expect(sceneTopK(null, 7)).toBe(7);
  });
});
