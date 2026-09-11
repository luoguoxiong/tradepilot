// @vitest-environment node
/**
 * 11 知识中心契约测试（真实后端 · 11 §1/§2/§3）：
 * 覆盖列表（分类/keyword/分页）、上传校验（42201）、软删留痕回溯、
 * 重试错误码、统计与 RAG 检索（noResult 明示）的 envelope 与错误码。
 *
 * 运行前需启动后端；本文件注册独立 org，文档数据通过上传接口自建。
 */
import { beforeAll, describe, expect, it } from 'vitest'

import type { PageResp } from '@/api/types/common'
import type { KnowledgeDocument, KnowledgeSearchResp, KnowledgeStats } from '@/api/types/knowledge'
import { ErrorCode } from '@/api/error-codes'

import { api, expectFail, expectOk, expectPage, registerOrg } from './_server'

/**
 * 手工构造 multipart body（jsdom FormData 经 fetch 管道解析不可靠）：
 * 服务端按标准 multipart 解析，与 axios FormData 行为同构。
 */
function multipartBody(
  fileName: string,
  category: string,
  content = 'file-content',
): { body: string; headers: Record<string, string> } {
  const boundary = '----contract-test-boundary'
  const body =
    [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${fileName}"`,
      'Content-Type: application/octet-stream',
      '',
      content,
      `--${boundary}`,
      'Content-Disposition: form-data; name="category"',
      '',
      category,
      `--${boundary}--`,
    ].join('\r\n') + '\r\n'
  return { body, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } }
}

let uploadedDocId = ''

beforeAll(async () => {
  await registerOrg()
})

describe('GET /knowledge/documents 列表契约（11 §1.1/§2）', () => {
  it('分页结构 + KnowledgeDocument 字段（新 org 可为空）', async () => {
    const p = expectPage<KnowledgeDocument>(
      expectOk((await api<PageResp<KnowledgeDocument>>('/knowledge/documents')).json),
    )
    expect(typeof p.total).toBe('number')
    for (const d of p.items) {
      for (const key of ['docId', 'fileName', 'category', 'status']) {
        expect(key in d, `缺少字段 ${key}`).toBe(true)
      }
      expect(d.deleted).toBeFalsy()
    }
  })

  it('category=all 非法 → 40001（「全部」Tab 应不传 category）', async () => {
    const { json } = await api('/knowledge/documents?category=all')
    expectFail(json, ErrorCode.BAD_REQUEST)
  })
})

describe('POST /knowledge/documents 上传契约（11 §3.1）', () => {
  it('multipart 上传成功：返回 docId + status=indexing，列表出现索引中行', async () => {
    const { body, headers } = multipartBody('contract-catalog.txt', 'product')
    const data = expectOk(
      (
        await api<{ docId: string; status: string }>('/knowledge/documents', {
          method: 'POST',
          body,
          headers,
        })
      ).json,
    )
    uploadedDocId = data.docId
    expect(uploadedDocId).toBeTruthy()
    expect(data.status).toBe('indexing')

    const list = expectOk(
      (await api<PageResp<KnowledgeDocument>>('/knowledge/documents?category=product')).json,
    )
    const row = list.items.find((d) => d.docId === uploadedDocId)
    expect(row).toBeTruthy()
    expect(row?.fileType).toBe('txt')
  })

  it('格式白名单外（.exe）→ 42201', async () => {
    const { body, headers } = multipartBody('virus.exe', 'other')
    const { json } = await api('/knowledge/documents', { method: 'POST', body, headers })
    expectFail(json, ErrorCode.BIZ_VALIDATION)
  })
})

describe('软删留痕契约（11 §3.4/§3.5）', () => {
  it('DELETE → deleted=true；列表即时失效；GET /{id} 仍可回溯（deleted 留痕字段）', async () => {
    const del = expectOk(
      (
        await api<{ deleted: boolean }>(`/knowledge/documents/${uploadedDocId}`, {
          method: 'DELETE',
        })
      ).json,
    )
    expect(del.deleted).toBe(true)

    const list = expectOk((await api<PageResp<KnowledgeDocument>>('/knowledge/documents')).json)
    expect(list.items.some((d) => d.docId === uploadedDocId)).toBe(false)

    const trace = expectOk(
      (await api<KnowledgeDocument>(`/knowledge/documents/${uploadedDocId}`)).json,
    )
    expect(trace.deleted).toBe(true)
    expect(trace.deletedAt).toBeTruthy()
  })

  it('重复删除 → 40901；删除不存在 → 40401', async () => {
    const again = await api(`/knowledge/documents/${uploadedDocId}`, { method: 'DELETE' })
    expectFail(again.json, ErrorCode.CONFLICT)
    const missing = await api('/knowledge/documents/doc-not-exist', { method: 'DELETE' })
    expectFail(missing.json, ErrorCode.NOT_FOUND)
  })
})

describe('POST /knowledge/documents/{id}/retry 重试契约（11 §3.2）', () => {
  it('不存在 → 40401；非 failed 状态 → 40901', async () => {
    const missing = await api('/knowledge/documents/doc-not-exist/retry', { method: 'POST' })
    expectFail(missing.json, ErrorCode.NOT_FOUND)
    const notFailed = await api(`/knowledge/documents/${uploadedDocId}/retry`, { method: 'POST' })
    expectFail(notFailed.json, ErrorCode.CONFLICT)
  })
})

describe('GET /knowledge/stats 统计契约（11 §1.2）', () => {
  it('documentsCount/chunksCount 为数值，lastIndexedAt 字段存在', async () => {
    const data = expectOk((await api<KnowledgeStats>('/knowledge/stats')).json)
    expect(typeof data.documentsCount).toBe('number')
    expect(typeof data.chunksCount).toBe('number')
    expect('lastIndexedAt' in data).toBe(true)
  })
})

describe('POST /knowledge/search 检索契约（11 §3.3）', () => {
  it('命中结果结构 + score 排序；无命中时 noResult 明示', async () => {
    const data = expectOk(
      (
        await api<KnowledgeSearchResp>('/knowledge/search', {
          method: 'POST',
          body: JSON.stringify({ query: 'MOQ lead time', topK: 5 }),
        })
      ).json,
    )
    expect(typeof data.noResult).toBe('boolean')
    expect(Array.isArray(data.results)).toBe(true)
    for (const key of ['docId', 'docName', 'chunkId', 'content', 'score']) {
      if (data.results[0]) expect(key in data.results[0], `缺少字段 ${key}`).toBe(true)
    }
    for (let i = 1; i < data.results.length; i++) {
      expect(data.results[i - 1].score).toBeGreaterThanOrEqual(data.results[i].score)
    }
  })

  it('query 为空 → 40001', async () => {
    const empty = await api('/knowledge/search', {
      method: 'POST',
      body: JSON.stringify({ query: '' }),
    })
    expectFail(empty.json, ErrorCode.BAD_REQUEST)
  })
})
