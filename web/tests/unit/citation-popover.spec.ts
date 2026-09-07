import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import CitationPopover from '@/components/business/CitationPopover.vue'
import { getKnowledgeDocument } from '@/api/resources/knowledge'
import { i18n } from '@/locales'
import type { KnowledgeDocument } from '@/api/types/knowledge'

vi.mock('@/api/resources/knowledge', () => ({
  getKnowledgeDocument: vi.fn(),
}))

/**
 * CitationPopover 单测（排期 M4-1 / 04 §2.2）：docId → 文档信息解析；
 * 软删文档标记「已删除」并禁再跳转（P1-5 留痕口径）。
 */
const deletedDoc: KnowledgeDocument = {
  docId: 'doc_deleted',
  fileName: 'London Run RFQ History.pdf',
  category: 'customer',
  status: 'indexed',
  uploadedAt: '2026-08-20T06:00:00Z',
  updatedBy: '张三',
  deleted: true,
}

const activeDoc: KnowledgeDocument = {
  docId: 'doc_active',
  fileName: 'Carbon Fiber Catalog.pdf',
  category: 'product',
  status: 'indexed',
  uploadedAt: '2026-09-01T02:00:00Z',
  updatedBy: '张三',
}

function mountPopover(
  citation: { docId: string; docName: string; chunkId?: string },
  jumpTo?: string,
) {
  return mount(CitationPopover, {
    props: { citation, ...(jumpTo ? { jumpTo } : {}) },
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('CitationPopover', () => {
  it('软删文档：解析后标记「已删除」，即使配置 jumpTo 也不渲染跳转', async () => {
    vi.mocked(getKnowledgeDocument).mockResolvedValue(deletedDoc)
    const wrapper = mountPopover(
      { docId: 'doc_deleted', docName: 'London Run RFQ History.pdf', chunkId: 'chk_5' },
      '/knowledge',
    )

    await wrapper.find('.citation-popover__trigger').trigger('click')
    await flushPromises()

    const panel = document.body.querySelector('.citation-popover__panel')
    expect(panel).not.toBeNull()
    expect(panel?.textContent).toContain('已删除')
    expect(panel?.textContent).toContain('London Run RFQ History.pdf')
    expect(panel?.textContent).toContain('张三')
    // 已删禁跳：无「查看原文」按钮（04 §2.1 / P1-5）
    expect(panel?.querySelector('.citation-popover__jump')).toBeNull()
  })

  it('有效文档：展示分类/上传人并提供跳转原文', async () => {
    vi.mocked(getKnowledgeDocument).mockResolvedValue(activeDoc)
    const wrapper = mountPopover(
      { docId: 'doc_active', docName: 'Carbon Fiber Catalog.pdf' },
      '/knowledge?doc=doc_active',
    )

    await wrapper.find('.citation-popover__trigger').trigger('click')
    await flushPromises()

    const panel = document.body.querySelector('.citation-popover__panel')
    expect(panel?.textContent).toContain('产品')
    expect(panel?.textContent).toContain('查看原文')
    expect(panel?.querySelector('.citation-popover__jump')).not.toBeNull()
  })

  it('解析失败：不展示已删标记也不提供跳转', async () => {
    vi.mocked(getKnowledgeDocument).mockRejectedValue(new Error('40401'))
    const wrapper = mountPopover({ docId: 'doc_missing', docName: 'Lost File.pdf' }, '/knowledge')

    await wrapper.find('.citation-popover__trigger').trigger('click')
    await flushPromises()

    const panel = document.body.querySelector('.citation-popover__panel')
    expect(panel?.textContent).toContain('无法解析该文档')
    expect(panel?.querySelector('.citation-popover__jump')).toBeNull()
  })
})
