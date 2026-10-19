/**
 * 经营报告行内片段解析（13 §1.4 五段报告轻渲染，与 `ReportMarkdown` 配套）。
 *
 * 报告正文由 `@tradepilot/core` 的模板生成，行内只用两种语法：
 * `**加粗**`（视觉强调）与 `[文本](地址)`（13 §4「evidence 可下钻」的证据链接）。
 * 解析成纯数据片段后由组件以文本节点 / vue-router 链接渲染，
 * 既不引入 markdown 依赖，也不使用 `v-html`（天然免疫注入）。
 */

/** 行内片段：href 存在即为可点击链接 */
export interface ReportSegment {
  text: string
  href?: string
}

const INLINE_LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g
const BOLD = /\*\*(.+?)\*\*/g

/** 解析单行文本 → 片段数组；无标记时返回单一片段（调用方无需分支处理） */
export function parseReportInline(text: string): ReportSegment[] {
  const source = text.replace(BOLD, '$1')
  const segments: ReportSegment[] = []
  let cursor = 0

  for (const match of source.matchAll(INLINE_LINK)) {
    const start = match.index ?? 0
    if (start > cursor) {
      segments.push({ text: source.slice(cursor, start) })
    }
    segments.push({ text: match[1], href: match[2] })
    cursor = start + match[0].length
  }

  if (cursor < source.length) {
    segments.push({ text: source.slice(cursor) })
  }
  return segments.length > 0 ? segments : [{ text: source }]
}
