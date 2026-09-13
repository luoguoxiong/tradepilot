/**
 * 08-产品中心（接口文档 08）：
 * 产品列表 / 详情（5 页签）/ 添加编辑 / 资料归档 / AI 分析与知识生成确认。
 */

/** 产品状态（08 §1.1 productStatus） */
export type ProductStatus = 'active' | 'draft' | 'archived'

/** 产品资料类型（08 §1.5 docType） */
export type ProductDocType = 'catalog' | 'certification' | 'test_report' | 'other'

/** 产品知识状态（08 §1.6）：draft = AI 生成待确认；approved = 人工确认启用 */
export type ProductKnowledgeStatus = 'draft' | 'approved'

/** AI 生成输入来源（08 §3.2）：结构化规格 / 定价（不含成本）/ 已索引资料 */
export type ProductKnowledgeSource = 'specifications' | 'pricing' | 'documents'

/** 产品列表行（08 §1.1） */
export interface ProductListItem {
  productId: string
  sku: string
  name: string
  image: string | null
  moq: number
  moqUnit: string
  status: ProductStatus
  category: string | null
}

/** 产品列表查询（08 §2：keyword=名称/SKU，category/status 精确） */
export interface ProductListQuery {
  keyword?: string
  category?: string
  status?: ProductStatus
  page?: number
  pageSize?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
}

/** 规格项（08 §1.3） */
export interface ProductSpecification {
  name: string
  value: string
  unit?: string
}

/** 阶梯价（08 §1.4） */
export interface ProductPriceTier {
  minQty: number
  unitPrice: string
}

/** 产品资料（08 §1.5） */
export interface ProductDocumentItem {
  fileId: string
  fileName: string
  docType: ProductDocType
  size: string | null
  uploadedAt: string
  /** 是否已入知识中心索引（归档异步） */
  indexed: boolean
}

/** 知识引用溯源（08 §3.2：citations 指向具体文档） */
export interface ProductKnowledgeCitation {
  docId: string
  chunkId?: string
  docName?: string
}

/** AI 知识（08 §1.6） */
export interface ProductKnowledge {
  advantages: string[]
  faqs: { question: string; answer: string }[]
  scenarios: string[]
  salesScripts: string[]
  status: ProductKnowledgeStatus
  citations: ProductKnowledgeCitation[]
  generatedAt: string | null
  confirmedBy: string | null
  confirmedAt: string | null
}

/** 产品详情（08 §1.2~§1.6 全量字段） */
export interface ProductDetail {
  productId: string
  sku: string
  name: string
  category: string | null
  image: string | null
  moq: number
  moqUnit: string
  leadTimeDays: number
  material: string | null
  description: string | null
  /** Pricing 结构化字段（成本价仅 admin/manager 编辑场景使用，AI 不改价） */
  costPrice: string
  currency: string
  suggestedPrice: string | null
  status: ProductStatus
  specifications: ProductSpecification[]
  priceTiers: ProductPriceTier[]
  documents: ProductDocumentItem[]
  /** 无生成记录时为 null */
  knowledge: ProductKnowledge | null
  createdAt: string
  updatedAt: string
}

/** 添加/编辑产品表单（08 §1.7） */
export interface ProductUpsertReq {
  name: string
  sku: string
  category?: string
  image?: string
  moq: number
  moqUnit?: string
  leadTimeDays: number
  material?: string
  description?: string
  costPrice: string
  currency?: string
  suggestedPrice?: string
  status?: ProductStatus
  specifications?: ProductSpecification[]
  priceTiers?: ProductPriceTier[]
}

/** 编辑（PUT 字段可选，仅更新传入项） */
export type ProductUpdateReq = Partial<ProductUpsertReq>

/** AI 分析/生成请求（08 §3.2/§3.3） */
export interface ProductKnowledgeReq {
  sources?: ProductKnowledgeSource[]
}

/** 上传资料响应（归档+索引异步执行，前端轮询详情至 indexed） */
export interface UploadProductDocumentResp {
  fileId: string
  indexed: boolean
}
