import { request } from '../http'
import type { PageResp } from '../types/common'
import type {
  ProductDetail,
  ProductDocType,
  ProductKnowledgeReq,
  ProductListItem,
  ProductListQuery,
  ProductUpdateReq,
  ProductUpsertReq,
  UploadProductDocumentResp,
} from '../types/products'

/**
 * 08-产品中心（接口文档 08 §2 接口清单）：
 * 列表/详情/新增/编辑 + 资料上传删除 + AI 分析/知识生成/人工确认。
 * 红线：costPrice 仅结构化字段出入，不参与 AI 生成（08 §3.2）。
 */

/** GET /products：产品列表（keyword=名称/SKU，category/status 过滤） */
export function getProducts(params: ProductListQuery) {
  return request<PageResp<ProductListItem>>({ url: '/products', method: 'GET', params })
}

/** GET /products/{id}：详情（5 页签全量字段） */
export function getProduct(productId: string) {
  return request<ProductDetail>({ url: `/products/${productId}`, method: 'GET' })
}

/** POST /products：新增产品（SKU 同企业唯一，重复 → 42201） */
export function createProduct(data: ProductUpsertReq) {
  return request<{ productId: string }>({ url: '/products', method: 'POST', data })
}

/** PUT /products/{id}：编辑产品（仅更新传入字段；规格/阶梯价为整体替换） */
export function updateProduct(productId: string, data: ProductUpdateReq) {
  return request<{ productId: string }>({ url: `/products/${productId}`, method: 'PUT', data })
}

/** POST /products/{id}/analyze：AI 分析（异步任务；仅预览不落库，不改产品基础字段） */
export function analyzeProduct(productId: string, data: ProductKnowledgeReq) {
  return request<{ taskId: string }>({
    url: `/products/${productId}/analyze`,
    method: 'POST',
    data,
  })
}

/** POST /products/{id}/knowledge/generate：AI 生成知识（落库 status=draft，待人工确认） */
export function generateProductKnowledge(productId: string, data: ProductKnowledgeReq) {
  return request<{ taskId: string }>({
    url: `/products/${productId}/knowledge/generate`,
    method: 'POST',
    data,
  })
}

/** POST /products/{id}/knowledge/confirm：人工确认启用（draft → approved；仅经理/管理员） */
export function confirmProductKnowledge(productId: string) {
  return request<{ productId: string; status: string }>({
    url: `/products/${productId}/knowledge/confirm`,
    method: 'POST',
  })
}

/** POST /products/{id}/documents：上传资料（multipart：file + docType；自动归档知识中心并索引） */
export function uploadProductDocument(productId: string, file: File, docType: ProductDocType) {
  const form = new FormData()
  form.append('file', file, file.name)
  form.append('docType', docType)
  return request<UploadProductDocumentResp>({
    url: `/products/${productId}/documents`,
    method: 'POST',
    data: form,
    // 浏览器自动设 multipart boundary，避免手动覆盖 Content-Type
    headers: { 'Content-Type': undefined },
  })
}

/** DELETE /products/{id}/documents/{fileId}：删除资料（级联软删知识文档；仅经理/管理员） */
export function deleteProductDocument(productId: string, fileId: string) {
  return request<{ deleted: boolean }>({
    url: `/products/${productId}/documents/${fileId}`,
    method: 'DELETE',
  })
}
