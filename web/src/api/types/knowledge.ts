/**
 * 11-知识中心（接口文档 11）：
 * docId → 文档信息解析（引用溯源，04 §2.1 CitationPopover 数据源），含软删留痕回溯。
 */

/** 知识分类（11 §1.1） */
export type KnowledgeCategory =
  'product' | 'company' | 'sales' | 'customer' | 'faq' | 'process' | 'other'

/** 索引状态（11 §1.1） */
export type KnowledgeDocStatus = 'indexed' | 'indexing' | 'failed'

/** 知识文档行（11 §1.1）；deleted 组为软删留痕字段（11 §3.4） */
export interface KnowledgeDocument {
  docId: string
  fileName: string
  category: KnowledgeCategory
  status: KnowledgeDocStatus
  error?: string
  size?: string
  fileType?: string
  uploadedAt?: string
  updatedBy?: string
  /** 非空 = 已软删（引用仍可回溯：报价/草稿/审批 outputs 的 docId 引用展示「已删除」） */
  deleted?: boolean
  deletedAt?: string
  deletedBy?: string
}

/** 知识统计（11 §1.2 FR-05） */
export interface KnowledgeStats {
  documentsCount: number
  chunksCount: number
  lastIndexedAt: string
}

/** 文档列表查询（11 §2：category/keyword；过滤已删） */
export interface KnowledgeListQuery {
  category?: KnowledgeCategory | 'all'
  keyword?: string
  page?: number
  pageSize?: number
}

/** 上传响应：索引异步执行，前端轮询列表至终态（11 §3.1） */
export interface UploadKnowledgeResp {
  docId: string
  status: 'indexing'
}

/** 检索场景（11 §3.3，对内 API 各 AI 员工调用；前端仅「检索预览」用 sales_reply） */
export type KnowledgeSearchScene =
  | 'lead_match'
  | 'sales_reply'
  | 'follow_up'
  | 'pricing_basis'
  | 'business_analysis'

/** 检索命中（11 §1.3：docId/docName/chunkId 溯源三元组 + content/score） */
export interface KnowledgeSearchHit {
  docId: string
  docName: string
  chunkId: string
  content: string
  /** 相关度 0~1 */
  score: number
  category?: KnowledgeCategory
}

/** RAG 检索请求（11 §3.3） */
export interface KnowledgeSearchReq {
  query: string
  category?: KnowledgeCategory[]
  topK?: number
  scene?: KnowledgeSearchScene
}

/** RAG 检索响应：noResult=true 时前端必须提示「知识库中没有相关信息」，禁止编造 */
export interface KnowledgeSearchResp {
  results: KnowledgeSearchHit[]
  noResult: boolean
}
