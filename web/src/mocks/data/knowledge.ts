import type { KnowledgeDocument } from '@/api/types/knowledge'

/**
 * M4-1 知识文档 mock（11 接口文档）：引用解析（GET /knowledge/documents/{id}）数据源。
 * 完整知识中心列表/上传/软删在 M6 交付，此处仅支撑 InsightCard 溯源弹层（04 §2.1）。
 * doc_3 模拟软删留痕：deleted=true 的文档仍可经 docId 回溯（11 §3.5）。
 */
export const mockKnowledgeDocuments: KnowledgeDocument[] = [
  {
    docId: 'doc_1',
    fileName: 'Carbon Fiber Catalog.pdf',
    category: 'product',
    status: 'indexed',
    size: '2.4 MB',
    fileType: 'pdf',
    uploadedAt: '2026-09-01T02:00:00Z',
    updatedBy: '张三',
  },
  {
    docId: 'doc_2',
    fileName: 'ABC Sports - Company Profile.pdf',
    category: 'company',
    status: 'indexed',
    size: '1.1 MB',
    fileType: 'pdf',
    uploadedAt: '2026-09-02T03:00:00Z',
    updatedBy: '李四',
  },
  {
    docId: 'doc_3',
    fileName: 'London Run RFQ History.pdf',
    category: 'customer',
    status: 'indexed',
    size: '0.6 MB',
    fileType: 'pdf',
    uploadedAt: '2026-08-20T06:00:00Z',
    updatedBy: '张三',
    deleted: true,
    deletedAt: '2026-09-05T01:00:00Z',
    deletedBy: '李四',
  },
]
