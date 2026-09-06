/**
 * AI 产出 Insight Schema（接口总览 §4.1）。
 * 凡 AI 生成结论（评分/概率/建议/风险/定价）必须携带证据链与置信度；禁止虚构。
 * jsonb 列以 `$type<Insight>()` 引用本推断类型，写入前 parse（后端技术方案 02 §1）。
 */
import { z } from 'zod';

export const insightReasonSchema = z.object({
  text: z.string().min(1),
  evidence: z.string().min(1),
  /** 取值如 web_crawl / knowledge_search / mailbox_sync */
  source: z.string().min(1),
});
export type InsightReason = z.infer<typeof insightReasonSchema>;

export const insightCitationSchema = z.object({
  docId: z.string().min(1),
  docName: z.string().min(1),
  chunkId: z.string().min(1),
});
export type InsightCitation = z.infer<typeof insightCitationSchema>;

export const insightSchema = z.object({
  /** 结论值（评分/百分比等；建议类为文本） */
  value: z.union([z.number(), z.string()]),
  /** 置信度 0~1 */
  confidence: z.number().min(0).max(1),
  reasons: z.array(insightReasonSchema).min(1),
  citations: z.array(insightCitationSchema).default([]),
  generatedAt: z.string().datetime(),
});
export type Insight = z.infer<typeof insightSchema>;
