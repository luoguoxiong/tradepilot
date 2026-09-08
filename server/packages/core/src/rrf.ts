/**
 * 混合检索 RRF 融合（后端技术方案 07 §4.1）：
 * 多路召回（向量 / 全文 / trgm 相似度）各按名次取倒数分，RRF 分数 = Σ 1/(k + rank)，k=60。
 * 纯函数——SQL 侧只产名次，融合在此复算，便于单测与调参（07 §5 融合权重可配置）。
 */

export const RRF_K = 60;

export interface RrfCandidate {
  id: string;
  /** 该路召回内的名次（1 起） */
  rank: number;
}

/** 单路名次 → RRF 分量 */
export function rrfScore(rank: number, k: number = RRF_K): number {
  return 1 / (k + Math.max(1, rank));
}

/**
 * 多路融合：同 id 分数求和，按分数降序输出；并列时按 id 字典序稳定排序（确定性可测）。
 */
export function fuseRrf(
  lists: RrfCandidate[][],
  k: number = RRF_K,
): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    for (const c of list) {
      scores.set(c.id, (scores.get(c.id) ?? 0) + rrfScore(c.rank, k));
    }
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id.localeCompare(b.id)));
}

/**
 * 场景差异化召回参数（07 §4.1 场景表）：
 * category 召回偏置与 Top-K 差异；null = 不限类目。
 */
export type SearchScene =
  | 'lead_match'
  | 'sales_reply'
  | 'follow_up'
  | 'pricing_basis'
  | 'business_analysis';

export function sceneCategories(scene?: SearchScene | null): string[] | null {
  switch (scene) {
    case 'lead_match':
      return ['product'];
    case 'sales_reply':
      return ['product', 'faq', 'sales', 'company'];
    case 'follow_up':
      return ['product', 'sales'];
    case 'pricing_basis':
      return ['product', 'process'];
    case 'business_analysis':
      return null;
    default:
      return null;
  }
}

export function sceneTopK(scene?: SearchScene | null, fallback = 5): number {
  return scene === 'business_analysis' ? Math.max(fallback, 10) : fallback;
}
