import { request } from '../http'
import type { PageResp } from '../types/common'
import type {
  KnowledgeDocument,
  KnowledgeListQuery,
  KnowledgeSearchReq,
  KnowledgeSearchResp,
  KnowledgeStats,
  UploadKnowledgeResp,
} from '../types/knowledge'

/**
 * 11-知识中心（接口文档 11 §2 接口清单）：
 * 列表/检索过滤已删文档；GET /{id} 引用解析不受已删过滤约束（软删留痕回溯）。
 */

/** GET /knowledge/documents：文档列表（category/keyword；过滤已删） */
export function getKnowledgeDocuments(params: KnowledgeListQuery) {
  return request<PageResp<KnowledgeDocument>>({
    url: '/knowledge/documents',
    method: 'GET',
    params,
  })
}

/** GET /knowledge/documents/{id}：引用解析（11 §3.5，含软删留痕回溯） */
export function getKnowledgeDocument(docId: string) {
  return request<KnowledgeDocument>({ url: `/knowledge/documents/${docId}`, method: 'GET' })
}

/** POST /knowledge/documents：批量上传（multipart，每文件一条；50MB/格式白名单校验 → 42201） */
export function uploadKnowledgeDocuments(files: File[], category: string) {
  const uploads = files.map((file) => {
    const form = new FormData()
    form.append('file', file)
    form.append('category', category)
    return request<UploadKnowledgeResp>({
      url: '/knowledge/documents',
      method: 'POST',
      data: form,
      // 浏览器自动设 multipart boundary，避免手动覆盖 Content-Type
      headers: { 'Content-Type': undefined },
    })
  })
  return Promise.all(uploads)
}

/** DELETE /knowledge/documents/{id}：删除知识（软删留痕，仅经理/管理员） */
export function deleteKnowledgeDocument(docId: string) {
  return request<{ deleted: boolean }>({
    url: `/knowledge/documents/${docId}`,
    method: 'DELETE',
  })
}

/** POST /knowledge/documents/{id}/retry：失败重试索引（仅经理/管理员） */
export function retryKnowledgeIndexing(docId: string) {
  return request<{ status: 'indexing' }>({
    url: `/knowledge/documents/${docId}/retry`,
    method: 'POST',
  })
}

/** GET /knowledge/stats：知识统计（Documents/Chunks/Last Updated） */
export function getKnowledgeStats() {
  return request<KnowledgeStats>({ url: '/knowledge/stats', method: 'GET' })
}

/** POST /knowledge/search：RAG 检索预览（AI 引用测试；noResult 必须明示） */
export function searchKnowledge(data: KnowledgeSearchReq) {
  return request<KnowledgeSearchResp>({ url: '/knowledge/search', method: 'POST', data })
}
