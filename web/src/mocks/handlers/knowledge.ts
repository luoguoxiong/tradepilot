import { http, delay } from 'msw'

import { ErrorCode } from '@/api/error-codes'
import type { KnowledgeCategory } from '@/api/types/knowledge'

import { mockKnowledgeChunks, mockKnowledgeDocuments, nextDocId } from '../data/knowledge'
import { LATENCY, fail, ok, page } from '../utils'

/** 上传白名单与大小上限（11 §3.1：pdf/docx/md/txt，50MB，超限 42201） */
const FILE_TYPE_WHITELIST = ['pdf', 'docx', 'md', 'txt']
const MAX_SIZE_BYTES = 50 * 1024 * 1024

const CATEGORIES: KnowledgeCategory[] = [
  'product',
  'company',
  'sales',
  'customer',
  'faq',
  'process',
  'other',
]

function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/** 从 part 的 Content-Disposition 提取 name / filename */
function dispositionField(header: string, field: 'name' | 'filename'): string | undefined {
  const match = new RegExp(`${field}="([^"]*)"`, 'i').exec(header)
  return match?.[1]
}

/** 手工解析 multipart 的 file/category 两个 part（与 request.formData() 同语义） */
async function parseMultipart(
  request: Request,
  boundary: string,
): Promise<{ fileName: string; fileSize: number; category: string } | null> {
  const text = await request.text()
  const parts = text.split(boundary).filter((p) => p && !p.startsWith('--'))
  let fileName: string | undefined
  let fileSize = 0
  let category: string | undefined
  for (const part of parts) {
    const [rawHeaders, ...bodyLines] = part.split('\r\n\r\n')
    const headers = rawHeaders.replace(/^\r\n/, '')
    const body = bodyLines.join('\r\n\r\n').replace(/\r\n$/, '')
    const disposition = headers.split('\r\n').find((h) => /content-disposition/i.test(h)) ?? ''
    const name = dispositionField(disposition, 'name')
    if (name === 'file') {
      fileName = dispositionField(disposition, 'filename')
      fileSize = body.length
    } else if (name === 'category') {
      category = body
    }
  }
  if (!fileName || !category) return null
  return { fileName, fileSize, category }
}

/**
 * 11 知识中心 mock（06 §5.3 mock 即契约）：
 * - 列表/检索过滤已删文档（软删 = 分块与向量随删动物理清除，11 §3.4）；
 * - GET /documents/{id} 引用解析不受已删过滤约束（软删留痕回溯，11 §3.5）；
 * - 上传 multipart 校验（42201）→ indexing；检索预览 noResult 明示禁止编造。
 */
export const knowledgeHandlers = [
  // ===== 3.1 上传（multipart）：格式白名单 + 50MB 上限 =====
  http.post('/api/v1/knowledge/documents', async ({ request }) => {
    await delay(1200)
    const contentType = request.headers.get('content-type') ?? ''
    const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
    const parsed = boundaryMatch
      ? await parseMultipart(request, `--${boundaryMatch[1] ?? boundaryMatch[2]}`)
      : null
    if (!parsed) {
      return fail(ErrorCode.BAD_REQUEST, 'file 不能为空')
    }
    const { fileName, fileSize, category } = parsed
    if (!CATEGORIES.includes(category as KnowledgeCategory)) {
      return fail(ErrorCode.BAD_REQUEST, 'category 非法')
    }
    const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
    if (!FILE_TYPE_WHITELIST.includes(ext)) {
      return fail(ErrorCode.BIZ_VALIDATION, `不支持的格式 .${ext}，仅限 pdf/docx/md/txt`)
    }
    if (fileSize > MAX_SIZE_BYTES) {
      return fail(ErrorCode.BIZ_VALIDATION, '文件超过 50MB 上限')
    }
    const doc: (typeof mockKnowledgeDocuments)[number] = {
      docId: nextDocId(),
      fileName,
      category: category as KnowledgeCategory,
      status: 'indexing',
      size: humanSize(fileSize),
      fileType: ext,
      uploadedAt: new Date().toISOString(),
      updatedBy: '张三',
    }
    mockKnowledgeDocuments.push(doc)
    // 模拟索引完成：8s 后转 indexed（轮询 3s 可观测两跳状态）
    setTimeout(() => {
      if (doc.status === 'indexing') doc.status = 'indexed'
    }, 8000)
    return ok({ docId: doc.docId, status: 'indexing' })
  }),

  // ===== 文档列表（category/keyword；过滤已删）=====
  http.get('/api/v1/knowledge/documents', async ({ request }) => {
    await delay(LATENCY)
    const url = new URL(request.url)
    // 与后端 listKnowledgeQuerySchema 对齐：category 为枚举，'all' 非法（「全部」Tab 应不传参）
    const rawCategory = url.searchParams.get('category')
    if (rawCategory !== null && !CATEGORIES.includes(rawCategory as KnowledgeCategory)) {
      return fail(ErrorCode.BAD_REQUEST, 'category 非法')
    }
    const category = rawCategory ?? 'all'
    const keyword = (url.searchParams.get('keyword') ?? '').toLowerCase()
    const pageNum = Number(url.searchParams.get('page') ?? 1)
    const pageSize = Number(url.searchParams.get('pageSize') ?? 20)

    let items = mockKnowledgeDocuments.filter((d) => !d.deleted)
    if (category !== 'all') items = items.filter((d) => d.category === category)
    if (keyword) items = items.filter((d) => d.fileName.toLowerCase().includes(keyword))
    const total = items.length
    const start = (pageNum - 1) * pageSize
    return ok(page(items.slice(start, start + pageSize), total, pageNum, pageSize))
  }),

  // ===== 引用解析（含软删留痕回溯，不受已删过滤约束）=====
  http.get('/api/v1/knowledge/documents/:docId', async ({ params }) => {
    await delay(LATENCY)
    const doc = mockKnowledgeDocuments.find((d) => d.docId === params.docId)
    if (!doc) return fail(ErrorCode.NOT_FOUND, '文档不存在或已被移除')
    return ok(doc)
  }),

  // ===== 3.2 失败重试索引 =====
  http.post('/api/v1/knowledge/documents/:docId/retry', async ({ params }) => {
    await delay(LATENCY)
    const doc = mockKnowledgeDocuments.find((d) => d.docId === params.docId)
    if (!doc) return fail(ErrorCode.NOT_FOUND, '文档不存在')
    if (doc.deleted) return fail(ErrorCode.NOT_FOUND, '文档已删除')
    if (doc.status !== 'failed') return fail(ErrorCode.CONFLICT, '仅失败状态可重试')
    doc.status = 'indexing'
    delete doc.error
    setTimeout(() => {
      if (doc.status === 'indexing') doc.status = 'indexed'
    }, 6000)
    return ok({ status: 'indexing' })
  }),

  // ===== 3.4 删除（软删留痕）：文档行保留，列表/检索即时失效 =====
  http.delete('/api/v1/knowledge/documents/:docId', async ({ params }) => {
    await delay(LATENCY)
    const doc = mockKnowledgeDocuments.find((d) => d.docId === params.docId)
    if (!doc) return fail(ErrorCode.NOT_FOUND, '文档不存在')
    if (doc.deleted) return fail(ErrorCode.CONFLICT, '文档已删除')
    doc.deleted = true
    doc.deletedAt = new Date().toISOString()
    doc.deletedBy = '张三'
    return ok({ deleted: true })
  }),

  // ===== 3.5 知识统计 =====
  http.get('/api/v1/knowledge/stats', async () => {
    await delay(LATENCY)
    const active = mockKnowledgeDocuments.filter((d) => !d.deleted)
    const chunksCount = mockKnowledgeChunks.filter((c) => {
      const doc = mockKnowledgeDocuments.find((d) => d.docId === c.docId)
      return doc ? !doc.deleted : false
    }).length
    const lastIndexedAt = active
      .filter((d) => d.status === 'indexed')
      .map((d) => d.uploadedAt ?? '')
      .sort()
      .at(-1)
    return ok({
      documentsCount: active.length,
      chunksCount,
      lastIndexedAt: lastIndexedAt ?? '',
    })
  }),

  // ===== 3.3 RAG 检索预览（noResult 明示，禁止编造）=====
  http.post('/api/v1/knowledge/search', async ({ request }) => {
    await delay(LATENCY)
    const body = (await request.json()) as {
      query?: string
      category?: KnowledgeCategory[]
      topK?: number
    }
    const query = (body.query ?? '').trim().toLowerCase()
    if (!query) return fail(ErrorCode.BAD_REQUEST, 'query 不能为空')
    const topK = body.topK ?? 5

    const liveDocIds = new Set(
      mockKnowledgeDocuments
        .filter((d) => !d.deleted && d.status === 'indexed')
        .map((d) => d.docId),
    )
    const hits = mockKnowledgeChunks
      .filter((c) => liveDocIds.has(c.docId))
      .filter((c) => (body.category?.length ? body.category.includes(c.category) : true))
      .map((c) => ({
        docId: c.docId,
        docName: c.docName,
        chunkId: c.chunkId,
        content: c.content,
        score: c.score,
        category: c.category,
      }))
      .filter((h) => query.split(/\s+/).some((term) => h.content.toLowerCase().includes(term)))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
    return ok({ results: hits, noResult: hits.length === 0 })
  }),
]
