import DOMPurify from 'dompurify'

/**
 * 富文本消毒统一入口（05 §4.1，XSS 首要风险源）：
 * - AI 生成内容 / 邮件正文（外部输入）/ 知识文档内容一律经 DOMPurify 白名单后注入；
 * - 禁止裸 v-html（ESLint vue/no-v-html）；邮件原文走沙箱 iframe 的 srcdoc 绑定，
 *   进 iframe 前仍先消毒（纵深防御，srcdoc 不执行脚本由 sandbox 保证）；
 * - 链接协议白名单 http/https/mailto（防 javascript:/data: 注入）。
 */

const ALLOWED_TAGS = [
  'p',
  'br',
  'div',
  'span',
  'strong',
  'em',
  'b',
  'i',
  'u',
  's',
  'ul',
  'ol',
  'li',
  'a',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
]

const ALLOWED_ATTR = ['href', 'colspan', 'rowspan']

/** 邮件原文 / 富文本展示白名单 */
const emailHooks = {
  afterSanitizeAttributes: (node: Element) => {
    // 外链统一新窗口打开 + 防反向 tabnabbing（DOMPurify 官方建议）
    if (node.tagName === 'A' && node.getAttribute('href')) {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
  },
}

export function sanitizeEmailHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    FORBID_ATTR: ['style', 'srcset'],
    ...emailHooks,
  })
}

/** 草稿编辑路径更严子集：仅段落/换行/强调/链接（DraftEditor setContent 前防御） */
export function sanitizeDraftFragment(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'b', 'i', 'u', 'a'],
    ALLOWED_ATTR: ['href'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  })
}
