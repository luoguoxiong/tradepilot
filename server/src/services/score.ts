import type { ScrapedPage } from '../prompts/analysis.js';

export interface ScoreDim {
  key: string; name: string; weight: number; earned: number; max: number;
  level: string; evidence: string;
}
export interface ScoreResult { score: number; grade: 'A' | 'B' | 'C' | 'D'; dims: ScoreDim[] }

/** 确定性评分引擎（红线：评分是规则计算，LLM 只产出 level 与 evidence） */
export function computeScore(analysis: {
  match: { level: string; evidence: string };
  importer: { level: string; evidence: string };
  market_fit: { level: string; evidence: string };
  scale_info: { founded?: string; employees?: string; certifications?: string[] } | null;
  scale_evidence?: string | null;
  contact: { emails: string[]; persons: string[]; has_form: boolean };
}): ScoreResult {
  const map3 = { high: 1, medium: 0.6, low: 0.2 } as const;
  const dims: ScoreDim[] = [
    {
      key: 'match', name: '产品匹配度', weight: 40, max: 40,
      level: analysis.match.level,
      earned: Math.round(40 * (map3[analysis.match.level as keyof typeof map3] ?? 0)),
      evidence: analysis.match.evidence,
    },
    {
      key: 'importer', name: '进口商/采购证据', weight: 25, max: 25,
      level: analysis.importer.level,
      earned: { strong: 25, weak: 15, none: 0 }[analysis.importer.level as 'strong' | 'weak' | 'none'] ?? 0,
      evidence: analysis.importer.evidence,
    },
    (() => {
      const si = analysis.scale_info;
      let earned = 0;
      if (si?.founded) earned += 5;
      if (si?.employees) earned += 5;
      if (si?.certifications?.length) earned += 5;
      return {
        key: 'scale', name: '规模与资质', weight: 15, max: 15,
        level: earned >= 15 ? 'strong' : earned > 0 ? 'partial' : 'none',
        earned,
        evidence: analysis.scale_evidence || '官网未提供规模/资质信息（计 0 分，不推测）',
      } as ScoreDim;
    })(),
    (() => {
      const c = analysis.contact;
      const earned = c.emails.length ? 10 : c.has_form ? 5 : 0;
      return {
        key: 'contact', name: '联系可得性', weight: 10, max: 10,
        level: earned === 10 ? 'strong' : earned > 0 ? 'weak' : 'none',
        earned,
        evidence: c.emails.length ? `发现邮箱: ${c.emails.join(', ')}` : c.has_form ? '仅提供联系表单' : '未发现联系方式',
      } as ScoreDim;
    })(),
    {
      key: 'market_fit', name: '市场匹配', weight: 10, max: 10,
      level: analysis.market_fit.level,
      earned: Math.round(10 * (map3[analysis.market_fit.level as keyof typeof map3] ?? 0)),
      evidence: analysis.market_fit.evidence,
    },
  ];
  const score = dims.reduce((s, d) => s + d.earned, 0);
  const grade: ScoreResult['grade'] = score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D';
  return { score, grade, dims };
}
