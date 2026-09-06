import { http, delay } from 'msw'

import { nextId } from '../data/db'
import { ok } from '../utils'

/**
 * POST /knowledge/documents（11 接口文档，初始化向导步骤 2 上传用）。
 * 返回 indexing 态，完整知识中心在 M6 交付；此处仅支撑 Uploader 链路演练。
 */
export const knowledgeHandlers = [
  http.post('/api/v1/knowledge/documents', async () => {
    await delay(1200)
    return ok({ docId: nextId('doc'), status: 'indexing' })
  }),
]
