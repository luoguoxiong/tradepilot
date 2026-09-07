import { describe, expect, it } from 'vitest'

import { sanitizeDraftFragment, sanitizeEmailHtml } from '@/utils/sanitize'

/**
 * sanitize 单测（05 §4.1，XSS 首要风险源）：
 * - 脚本/事件属性/javascript: URI 一律剥离；
 * - a[href] 协议白名单 http/https/mailto；
 * - 白名单外的标签剥壳留内容（如 table 之外的 div 保留）。
 */
describe('sanitizeEmailHtml（邮件原文白名单）', () => {
  it('剥离 <script> 节点', () => {
    const out = sanitizeEmailHtml('<p>hi</p><script>alert(1)</script>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('alert')
    expect(out).toContain('hi')
  })

  it('剥离 on* 事件属性', () => {
    const out = sanitizeEmailHtml('<p onclick="alert(1)" onmouseover="x()">text</p>')
    expect(out).not.toContain('onclick')
    expect(out).not.toContain('onmouseover')
    expect(out).toContain('text')
  })

  it('a[href] 允许 http/https/mailto，拒绝 javascript:/data:', () => {
    expect(sanitizeEmailHtml('<a href="https://a.com">ok</a>')).toContain('href="https://a.com"')
    expect(sanitizeEmailHtml('<a href="mailto:a@b.com">ok</a>')).toContain('mailto:a@b.com')
    const js = sanitizeEmailHtml('<a href="javascript:alert(1)">bad</a>')
    expect(js).not.toContain('javascript:')
    const data = sanitizeEmailHtml('<a href="data:text/html,<script>x</script>">bad</a>')
    expect(data).not.toContain('data:')
  })

  it('img/style 等白名单外内容剥离（邮件原文不含远程图与内联样式）', () => {
    const out = sanitizeEmailHtml('<img src=x onerror=alert(1)><div style="color:red">t</div>')
    expect(out).not.toContain('<img')
    expect(out).not.toContain('style')
    expect(out).toContain('t')
  })

  it('业务标签（table/blockquote/strong）保留', () => {
    const out = sanitizeEmailHtml(
      '<table><tr><td>MOQ</td></tr></table><blockquote><strong>q</strong></blockquote>',
    )
    expect(out).toContain('<table>')
    expect(out).toContain('<td>MOQ</td>')
    expect(out).toContain('<strong>')
  })
})

describe('sanitizeDraftFragment（草稿路径更严子集）', () => {
  it('仅保留段落/换行/强调/链接，表格剥壳', () => {
    const out = sanitizeDraftFragment('<p>a<br>b<strong>c</strong></p><table><tr><td>d</td></tr></table>')
    expect(out).toContain('<p>')
    expect(out).toContain('<strong>c</strong>')
    expect(out).not.toContain('<table')
    expect(out).toContain('d')
  })

  it('空输入与纯文本安全往返', () => {
    expect(sanitizeEmailHtml('')).toBe('')
    expect(sanitizeDraftFragment('plain text')).toContain('plain text')
  })
})
