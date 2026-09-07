import { http, delay } from 'msw'

import { ErrorCode } from '@/api/error-codes'

import { mockKnowledgeDocuments } from '../data/knowledge'
import { nextId } from '../data/db'
import { LATENCY, fail, ok } from '../utils'

/**
 * 11 知识中心 mock：
 * - POST 上传（初始化向导步骤 2 演练用，完整知识中心在 M6 交付）；
 * - GET /documents/{id} 引用解析（M4-1 新增，11 §3.5）：软删文档仍可回溯，未收录返回 40401。
 */
export const knowledgeHandlers = [
  http.post('/api/v1/knowledge/documents', async () => {
    await delay(1200)
    return ok({ docId: nextId('doc'), status: 'indexing' })
  }),

  http.get('/api/v1/knowledge/documents/:docId', async ({ params }) => {
    await delay(LATENCY)
    const doc = mockKnowledgeDocuments.find((d) => d.docId === params.docId)
    if (!doc) return fail(ErrorCode.NOT_FOUND, '文档不存在或已被移除')
    return ok(doc)
  }),
]
