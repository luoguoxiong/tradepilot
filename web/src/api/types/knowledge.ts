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
