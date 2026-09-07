import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import InsightCard from '@/components/business/InsightCard.vue'
import { i18n } from '@/locales'
import type { Insight } from '@/api/types/insight'

/**
 * InsightCard 单测（排期 M4-1 / 04 §2.1）：
 * confidence 三档视觉分级 / reasons 证据链 / citations 分组 chip / estimated 角标 / 低置信角标。
 */
function makeInsight(overrides: Partial<Insight<number>> = {}): Insight<number> {
  return {
    value: 92,
    confidence: 0.92,
    reasons: [{ text: '产品高度匹配', evidence: '在售跑鞋配件线', source: 'web_crawl' }],
    generatedAt: '2026-09-06T08:00:00Z',
    ...overrides,
  }
}

function mountCard(insight: Insight<number>, valueLabel?: string) {
  return mount(InsightCard, {
    props: { insight, ...(valueLabel ? { valueLabel } : {}) },
    global: { plugins: [i18n] },
  })
}

describe('InsightCard', () => {
  it('渲染结论值 + 置信度条，高置信为实色档（data-tier=high）', () => {
    const wrapper = mountCard(makeInsight(), '采购概率')
    expect(wrapper.text()).toContain('采购概率')
    expect(wrapper.text()).toContain('92%')
    expect(wrapper.find('.insight-card__conf-fill').attributes('data-tier')).toBe('high')
    expect(wrapper.find('.insight-card__low-badge').exists()).toBe(false)
  })

  it('0.5~0.8 置信度为半透明档（data-tier=mid）', () => {
    const wrapper = mountCard(makeInsight({ confidence: 0.6 }))
    expect(wrapper.find('.insight-card__conf-fill').attributes('data-tier')).toBe('mid')
    expect(wrapper.text()).toContain('60%')
    expect(wrapper.find('.insight-card__low-badge').exists()).toBe(false)
  })

  it('<0.5 置信度置灰档 + 低置信角标（data-tier=low）', () => {
    const wrapper = mountCard(makeInsight({ confidence: 0.42 }))
    expect(wrapper.find('.insight-card__conf-fill').attributes('data-tier')).toBe('low')
    expect(wrapper.find('.insight-card__low-badge').exists()).toBe(true)
    expect(wrapper.find('.insight-card__low-badge').text()).toBe('低置信')
    expect(wrapper.find('.insight-card__value--low').exists()).toBe(true)
  })

  it('逐条渲染 reasons（text/evidence/source）', () => {
    const wrapper = mountCard(
      makeInsight({
        reasons: [
          { text: '产品高度匹配', evidence: '在售跑鞋配件线', source: 'web_crawl' },
          { text: '公司规模符合目标', evidence: '员工 500+' },
        ],
      }),
    )
    const reasons = wrapper.findAll('.insight-card__reason')
    expect(reasons).toHaveLength(2)
    expect(wrapper.text()).toContain('来源：web_crawl')
    expect(wrapper.text()).toContain('分析于')
  })

  it('reasons 为空时展示空态文案', () => {
    const wrapper = mountCard(makeInsight({ reasons: [] }))
    expect(wrapper.text()).toContain('暂无判断依据')
  })

  it('citations 按 docId 聚合去重，chunk 多命中显示 ×N', () => {
    const wrapper = mountCard(
      makeInsight({
        citations: [
          { docId: 'doc_1', docName: 'Carbon Fiber Catalog.pdf', chunkId: 'chk_1' },
          { docId: 'doc_1', docName: 'Carbon Fiber Catalog.pdf', chunkId: 'chk_2' },
          { docId: 'doc_2', docName: 'ABC Sports - Profile.pdf', chunkId: 'chk_3' },
        ],
      }),
    )
    const chips = wrapper.findAll('.insight-card__cite')
    expect(chips).toHaveLength(2)
    expect(chips[0].text()).toContain('Carbon Fiber Catalog.pdf')
    expect(chips[0].text()).toContain('×2')
    expect(chips[1].text()).toContain('ABC Sports - Profile.pdf')
  })

  it('无 citations 时不渲染引用区', () => {
    const wrapper = mountCard(makeInsight())
    expect(wrapper.find('.insight-card__cite').exists()).toBe(false)
  })

  it('estimated: true 强制角标（业务报告约束）', () => {
    const wrapper = mountCard(makeInsight({ estimated: true }))
    expect(wrapper.find('.insight-card__estimated').exists()).toBe(true)
    expect(wrapper.find('.insight-card__estimated').text()).toBe('estimated')
  })
})
