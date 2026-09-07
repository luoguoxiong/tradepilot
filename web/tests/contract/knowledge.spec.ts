/**
 * 11 知识中心契约测试（11 接口文档 §3 · 接口规范 §2）：
 * 覆盖列表（过滤已删/分类/keyword/分页）、上传校验（42201）、软删留痕回溯、
 * 失败重试、统计与 RAG 检索（noResult 明示）的 envelope、错误码与关键字段结构。
 *
 * 测试顺序有状态依赖（同文件内共享 mock 内存态，vitest 文件间隔离）。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/mocks/utils', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, LATENCY: 0 }
})

import { ErrorCode } from '@/api/error-codes'
import type {
  KnowledgeDocument,
  KnowledgeSearchResp,
  KnowledgeStats,
} from '@/api/types/knowledge'
import type { PageResp } from '@/api/types/common'

import { api, contractServer, expectFail, expectOk, expectPage } from './_server'

/**
 * 手工构造 multipart body（jsdom FormData 经 msw/node fetch 管道解析不可靠）：
 * 服务端（msw request.formData()）按标准 multipart 解析，与 axios FormData 行为同构。
 */
function multipartBody(fileName: string, category: string): {
  body: string
  headers: Record<string, string>
} {
  const boundary = '----contract-test-boundary'
  const body =
    [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${fileName}"`,
      'Content-Type: application/octet-stream',
      '',
      'file-content',
      `--${boundary}`,
      'Content-Disposition: form-data; name="category"',
      '',
      category,
      `--${boundary}--`,
    ].join('\r\n') + '\r\n'
  return { body, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } }
}

beforeAll(() => contractServer.listen({ onUnhandledRequest: 'error' }))
afterEach(() => contractServer.resetHandlers())
afterAll(() => contractServer.close())

describe('GET /knowledge/documents 列表契约（11 §1.1/§2）', () => {
  it('分页结构 + KnowledgeDocument 字段；软删文档不出现在列表', async () => {
    const { json } = await api<PageResp<KnowledgeDocument>>('/knowledge/documents')
    const p = expectPage<KnowledgeDocument>(expectOk(json))
    expect(p.total).toBeGreaterThan(0)
    for (const key of ['docId', 'fileName', 'category', 'status']) {
      expect(key in p.list[0], `缺少字段 ${key}`).toBe(true)
    }
    // doc_3 为软删种子（deleted=true），列表强制过滤（11 §3.4）
    expect(p.list.some((d) => d.docId === 'doc_3')).toBe(false)
    expect(p.list.every((d) => !d.deleted)).toBe(true)
  })

  it('category 过滤生效；keyword 按文件名过滤（大小写不敏感）', async () => {
    const product = expectOk(
      (await api<PageResp<KnowledgeDocument>>('/knowledge/documents?category=product')).json,
    )
    expect(product.list.length).toBeGreaterThan(0)
    expect(product.list.every((d) => d.category === 'product')).toBe(true)
    const kw = expectOk(
      (await api<PageResp<KnowledgeDocument>>('/knowledge/documents?keyword=carbon')).json,
    )
    expect(kw.total).toBe(1)
    expect(kw.list[0].docId).toBe('doc_1')
  })
})

describe('POST /knowledge/documents 上传契约（11 §3.1）', () => {
  it('multipart 上传成功：返回 docId + status=indexing，列表出现索引中行', async () => {
    const { body, headers } = multipartBody('Contract Test Catalog.pdf', 'product')
    const { json } = await api<{ docId: string; status: string }>('/knowledge/documents', {
      method: 'POST',
      body,
      headers,
    })
    const data = expectOk(json)
    expect(data.docId).toBeTruthy()
    expect(data.status).toBe('indexing')

    const list = expectOk(
      (await api<PageResp<KnowledgeDocument>>('/knowledge/documents?category=product')).json,
    )
    const row = list.list.find((d) => d.docId === data.docId)
    expect(row?.status).toBe('indexing')
    expect(row?.fileType).toBe('pdf')
  })

  it('格式白名单外（.exe）→ 42201', async () => {
    const { body, headers } = multipartBody('virus.exe', 'other')
    const { json } = await api('/knowledge/documents', {
      method: 'POST',
      body,
      headers,
    })
    expectFail(json, ErrorCode.BIZ_VALIDATION)
  })
})

describe('软删留痕契约（11 §3.4/§3.5）', () => {
  it('DELETE → deleted=true；列表即时失效；GET /{id} 仍可回溯（deleted 留痕字段）', async () => {
    const del = await api<{ deleted: boolean }>('/knowledge/documents/doc_2', {
      method: 'DELETE',
    })
    expect(expectOk(del.json).deleted).toBe(true)

    const list = expectOk((await api<PageResp<KnowledgeDocument>>('/knowledge/documents')).json)
    expect(list.list.some((d) => d.docId === 'doc_2')).toBe(false)

    const trace = expectOk(
      (await api<KnowledgeDocument>('/knowledge/documents/doc_2')).json,
    )
    expect(trace.deleted).toBe(true)
    expect(trace.deletedAt).toBeTruthy()
    expect(trace.deletedBy).toBeTruthy()
    expect(trace.fileName).toBe('ABC Sports - Company Profile.pdf')
  })

  it('重复删除 → 40901；删除不存在 → 40401', async () => {
    const again = await api('/knowledge/documents/doc_2', { method: 'DELETE' })
    expectFail(again.json, ErrorCode.CONFLICT)
    const missing = await api('/knowledge/documents/doc-not-exist', { method: 'DELETE' })
    expectFail(missing.json, ErrorCode.NOT_FOUND)
  })
})

describe('POST /knowledge/documents/{id}/retry 重试契约（11 §3.2）', () => {
  it('failed → indexing（error 清除）；非 failed 状态 → 40901；不存在 → 40401', async () => {
    const retry = await api<{ status: string }>('/knowledge/documents/doc_5/retry', {
      method: 'POST',
    })
    const data = expectOk(retry.json)
    expect(data.status).toBe('indexing')

    const list = expectOk((await api<PageResp<KnowledgeDocument>>('/knowledge/documents')).json)
    const row = list.list.find((d) => d.docId === 'doc_5')
    expect(row?.status).toBe('indexing')

    const notFailed = await api('/knowledge/documents/doc_1/retry', { method: 'POST' })
    expectFail(notFailed.json, ErrorCode.CONFLICT)
    const missing = await api('/knowledge/documents/doc-not-exist/retry', { method: 'POST' })
    expectFail(missing.json, ErrorCode.NOT_FOUND)
  })
})

describe('GET /knowledge/stats 统计契约（11 §1.2）', () => {
  it('documentsCount/chunksCount 排除已删；lastIndexedAt 非空', async () => {
    const { json } = await api<KnowledgeStats>('/knowledge/stats')
    const data = expectOk(json)
    expect(typeof data.documentsCount).toBe('number')
    expect(typeof data.chunksCount).toBe('number')
    // 7 条种子 + 1 条上传 - doc_2/doc_3 已软删 = 6
    expect(data.documentsCount).toBe(6)
    expect(data.lastIndexedAt).toBeTruthy()
  })
})

describe('POST /knowledge/search 检索契约（11 §3.3）', () => {
  it('命中三元组（docId/docName/chunkId）+ score 排序；已删/索引中文档不命中', async () => {
    const { json } = await api<KnowledgeSearchResp>('/knowledge/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'MOQ lead time', topK: 5 }),
    })
    const data = expectOk(json)
    expect(data.noResult).toBe(false)
    expect(data.results.length).toBeGreaterThan(0)
    for (const key of ['docId', 'docName', 'chunkId', 'content', 'score']) {
      expect(key in data.results[0], `缺少字段 ${key}`).toBe(true)
    }
    for (let i = 1; i < data.results.length; i++) {
      expect(data.results[i - 1].score).toBeGreaterThanOrEqual(data.results[i].score)
    }
    // doc_3 软删、doc_6 indexing 均不命中
    expect(data.results.some((h) => h.docId === 'doc_3')).toBe(false)
    expect(data.results.some((h) => h.docId === 'doc_6')).toBe(false)
  })

  it('noResult=true 明示（无命中不编造）；query 为空 → 40001', async () => {
    const miss = await api<KnowledgeSearchResp>('/knowledge/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'zzz-no-hit-term-zzz' }),
    })
    const data = expectOk(miss.json)
    expect(data.noResult).toBe(true)
    expect(data.results).toEqual([])

    const empty = await api('/knowledge/search', {
      method: 'POST',
      body: JSON.stringify({ query: '  ' }),
    })
    expectFail(empty.json, ErrorCode.BAD_REQUEST)
  })
})
