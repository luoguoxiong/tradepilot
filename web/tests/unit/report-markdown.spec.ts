import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import ReportMarkdown from '@/features/manager/components/ReportMarkdown.vue'
import { parseReportInline } from '@/features/manager/report-inline'

/**
 * 经营报告轻渲染单测（13 §1.4 五段报告 / §4「evidence 可下钻」）：
 * - 行内解析：剥离 `**加粗**`、把 `[文本](地址)` 拆成可点击片段、纯文本原样返回；
 * - 组件渲染：##/###/列表/引用映射到对应标签，证据行渲染为可跳转链接（文本节点渲染，无 v-html）。
 */
const RouterLinkStub = {
  props: ['to'],
  template: '<a class="router-link-stub" :href="to"><slot /></a>',
}

function mountContent(content: string) {
  return mount(ReportMarkdown, {
    props: { content },
    global: { stubs: { RouterLink: RouterLinkStub } },
  })
}

describe('parseReportInline', () => {
  it('剥离加粗标记，保留纯文本', () => {
    expect(parseReportInline('**结论**：环比增长')).toEqual([{ text: '结论：环比增长' }])
  })

  it('把 [文本](地址) 拆为链接片段并保留前后文本', () => {
    expect(
      parseReportInline('证据：近 30 天询盘 1 → 3（[下钻明细](/data-center?metric=inquiries)）'),
    ).toEqual([
      { text: '证据：近 30 天询盘 1 → 3（' },
      { text: '下钻明细', href: '/data-center?metric=inquiries' },
      { text: '）' },
    ])
  })

  it('无标记文本返回单一片段（调用方无需分支）', () => {
    expect(parseReportInline('一、经营概览')).toEqual([{ text: '一、经营概览' }])
  })
})

describe('ReportMarkdown', () => {
  const CONTENT = [
    '# 日报（2026-09-13 ~ 2026-09-13）',
    '',
    '> 生成时间：2026-09-13 10:28 · 数据来源：业务表实时聚合',
    '',
    '## 一、经营概览',
    '',
    '- 新客户：0',
    '- 新询盘：0',
    '',
    '## 二、机会洞察',
    '',
    '### DE市场机会',
    '',
    '- 证据：近 30 天询盘 1 → 3（[下钻明细](/data-center?metric=inquiries&country=DE)）',
  ].join('\n')

  it('渲染标题 / 列表 / 引用（# 一级标题不渲染为段落）', () => {
    const wrapper = mountContent(CONTENT)

    expect(wrapper.findAll('.report-markdown__h2').map((h) => h.text())).toEqual([
      '一、经营概览',
      '二、机会洞察',
    ])
    expect(wrapper.findAll('.report-markdown__h3').map((h) => h.text())).toEqual(['DE市场机会'])
    expect(wrapper.findAll('.report-markdown__list li').map((li) => li.text())).toEqual([
      '新客户：0',
      '新询盘：0',
      '证据：近 30 天询盘 1 → 3（下钻明细）',
    ])
    expect(wrapper.find('.report-markdown__quote').text()).toContain('生成时间：2026-09-13 10:28')
  })

  it('证据链接渲染为可跳转元素且不带 markdown 语法残留', () => {
    const wrapper = mountContent(CONTENT)
    const link = wrapper.find('.report-markdown__list .router-link-stub')

    expect(link.attributes('href')).toBe('/data-center?metric=inquiries&country=DE')
    expect(link.text()).toBe('下钻明细')
    expect(wrapper.text()).not.toContain('](')
  })

  it('空内容渲染空容器（不报错）', () => {
    const wrapper = mountContent('')

    expect(wrapper.findAll('.report-markdown__p')).toHaveLength(0)
  })
})
