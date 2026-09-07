import type { KnowledgeDocument } from '@/api/types/knowledge'

/**
 * 11 知识中心 mock 内存态（11 接口文档；06 §5.3 mock 即契约）：
 * - 全分类种子 + 三态（indexed/indexing/failed）演示轮询与重试；
 * - doc_3 软删留痕：deleted=true 不进列表/检索，但 GET /{id} 仍可回溯（11 §3.5）；
 * - mockKnowledgeChunks 为检索预览（RAG）命中数据源，chunk 属软删即清除语义。
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
  {
    docId: 'doc_4',
    fileName: 'MOQ & Lead Time FAQ.md',
    category: 'faq',
    status: 'indexed',
    size: '48 KB',
    fileType: 'md',
    uploadedAt: '2026-09-03T07:30:00Z',
    updatedBy: '张三',
  },
  {
    docId: 'doc_5',
    fileName: 'Sales Playbook 2026.docx',
    category: 'sales',
    status: 'failed',
    error: 'OCR parsing failed: encrypted docx',
    size: '3.8 MB',
    fileType: 'docx',
    uploadedAt: '2026-09-04T09:00:00Z',
    updatedBy: '李四',
  },
  {
    docId: 'doc_6',
    fileName: 'Trade Show Follow-up Process.md',
    category: 'process',
    status: 'indexing',
    size: '96 KB',
    fileType: 'md',
    uploadedAt: '2026-09-07T01:20:00Z',
    updatedBy: '张三',
  },
  {
    docId: 'doc_7',
    fileName: 'Shipping Terms Guide.pdf',
    category: 'other',
    status: 'indexed',
    size: '1.9 MB',
    fileType: 'pdf',
    uploadedAt: '2026-08-28T04:00:00Z',
    updatedBy: '王五',
  },
]

/** 检索预览 chunk 库（11 §1.3）：docId 归属软删文档的 chunk 视为已清除 */
export const mockKnowledgeChunks = [
  {
    chunkId: 'chk_11',
    docId: 'doc_1',
    docName: 'Carbon Fiber Catalog.pdf',
    category: 'product' as const,
    content: 'MOQ 500 pairs per style. Lead time 25 days after deposit. Carbon fiber insole reduces weight by 30% versus TPU.',
    score: 0.91,
  },
  {
    chunkId: 'chk_12',
    docId: 'doc_4',
    docName: 'MOQ & Lead Time FAQ.md',
    category: 'faq' as const,
    content: 'Q: What is the MOQ for custom logo? A: 1000 pairs for logo customization, 500 pairs for stocked styles.',
    score: 0.78,
  },
  {
    chunkId: 'chk_13',
    docId: 'doc_7',
    docName: 'Shipping Terms Guide.pdf',
    category: 'other' as const,
    content: 'FOB Shenzhen is our default quote term. Express samples ship via DHL within 5 working days.',
    score: 0.64,
  },
  {
    chunkId: 'chk_14',
    docId: 'doc_3',
    docName: 'London Run RFQ History.pdf',
    category: 'customer' as const,
    content: 'London Run requested 2000 pairs RFQ at $8.5 FOB, target delivery March.',
    score: 0.55,
  },
]

let docSeq = 8
export function nextDocId(): string {
  return `doc_${docSeq++}`
}
