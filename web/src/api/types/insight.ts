/**
 * 通用 Insight Schema（接口规范 00 §4.1）：凡 AI 生成结论（评分/概率/建议/风险）
 * 一律携带证据链与置信度；前端用 InsightCard（04 §2.1）统一呈现。
 */

/** 单条判断原因（逐条证据，禁止虚构） */
export interface InsightReason {
  text: string
  evidence?: string
  source?: string
}

/** 知识库引用溯源三元组（docId/docName/chunkId，11 §1.3） */
export interface InsightCitation {
  docId: string
  docName: string
  chunkId?: string
}

export interface Insight<TValue = number> {
  value: TValue
  /** 置信度 0~1 */
  confidence: number
  reasons: InsightReason[]
  citations?: InsightCitation[]
  /** 基于估算数据（业务报告强制角标） */
  estimated?: boolean
  /** ISO 8601 UTC */
  generatedAt?: string
}

/** 相同 docId 的引用聚合（多 chunk 命中显示 ×N，04 §2.1） */
export interface InsightCitationGroup extends InsightCitation {
  count: number
}
