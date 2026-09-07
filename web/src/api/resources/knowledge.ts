import { request } from '../http'
import type { KnowledgeDocument } from '../types/knowledge'

/**
 * GET /knowledge/documents/{id}：引用解析（11 §3.5）。
 * 列表/检索过滤已删文档，但历史引用的 docId 仍须可解析（软删留痕回溯），
 * 命中软删文档返回 deleted: true，前端据此标记「已删除」并禁跳转（04 §2.1）。
 */
export function getKnowledgeDocument(docId: string) {
  return request<KnowledgeDocument>({ url: `/knowledge/documents/${docId}`, method: 'GET' })
}
