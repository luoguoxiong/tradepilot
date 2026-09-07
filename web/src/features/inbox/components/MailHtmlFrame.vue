<script setup lang="ts">
import { computed } from 'vue'

import { sanitizeEmailHtml } from '@/utils/sanitize'

/**
 * 邮件原文沙箱渲染（06 §4 安全基线）：
 * - iframe sandbox="allow-popups allow-same-origin"（禁脚本/禁表单，外链经 DOMPurify 补 target=_blank 后弹新窗）；
 * - 注入前仍先过 sanitizeEmailHtml 白名单（纵深防御，srcdoc 不执行脚本由 sandbox 保证）；
 * - 纯文本消息按 <p> 白名单包装，保持与富文本一致的排版口径。
 */
const props = defineProps<{
  /** 邮件内容：HTML 原文或纯文本 */
  content: string
  /** 纯文本模式（content 不含 HTML 标签时按段落包装） */
  plain?: boolean
  minHeight?: string
}>()

const srcDoc = computed(() => {
  const body = props.plain
    ? props.content
        .split(/\n{2,}|\n/)
        .filter((p) => p.trim())
        .map((p) => `<p>${escapeHtml(p.trim())}</p>`)
        .join('')
    : sanitizeEmailHtml(props.content)

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:16px 20px;font:14px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;color:var(--t-text,#303133);background:transparent;word-break:break-word;}
    p{margin:0 0 12px;}
    a{color:#2563eb;}
    blockquote{margin:0 0 12px;padding:4px 12px;border-left:3px solid #dcdfe6;color:#606266;}
    table{border-collapse:collapse;} td,th{border:1px solid #dcdfe6;padding:4px 8px;}
  </style></head><body>${body}</body></html>`
})

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
</script>

<template>
  <iframe
    class="mail-html-frame"
    sandbox="allow-popups allow-popups-to-escape-sandbox"
    :srcdoc="srcDoc"
    :style="{ minHeight: minHeight ?? '120px' }"
    title="mail-content"
  />
</template>

<style scoped lang="scss">
.mail-html-frame {
  display: block;
  width: 100%;
  border: none;
  background: transparent;
}
</style>
