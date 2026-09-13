<script setup lang="ts">
import { computed } from 'vue'

import ReportInline from './ReportInline.vue'
import { parseReportInline, type ReportSegment } from '../report-inline'

/**
 * 经营报告 Markdown 轻渲染（13 §1.4 五段报告）。
 * 仅支持报告模板使用的语法子集（## / ### / - / > / 行内链接），以文本节点渲染而非 v-html，
 * 无需引入 markdown 依赖且天然免疫注入。
 */
const props = defineProps<{ content: string | null }>()

interface Block {
  type: 'h2' | 'h3' | 'list' | 'quote' | 'paragraph'
  segments?: ReportSegment[]
  items?: ReportSegment[][]
}

const blocks = computed<Block[]>(() => {
  const result: Block[] = []
  let bullets: ReportSegment[][] = []

  const flush = () => {
    if (bullets.length > 0) {
      result.push({ type: 'list', items: bullets })
      bullets = []
    }
  }

  for (const raw of (props.content ?? '').split('\n')) {
    const line = raw.trimEnd()
    if (line.trim().length === 0) {
      flush()
      continue
    }
    if (line.startsWith('### ')) {
      flush()
      result.push({ type: 'h3', segments: parseReportInline(line.slice(4)) })
    } else if (line.startsWith('## ')) {
      flush()
      result.push({ type: 'h2', segments: parseReportInline(line.slice(3)) })
    } else if (line.startsWith('- ')) {
      bullets.push(parseReportInline(line.slice(2)))
    } else if (line.startsWith('> ')) {
      flush()
      result.push({ type: 'quote', segments: parseReportInline(line.slice(2)) })
    } else {
      flush()
      result.push({ type: 'paragraph', segments: parseReportInline(line) })
    }
  }
  flush()
  return result
})
</script>

<template>
  <div class="report-markdown" data-testid="report-content">
    <template v-for="(block, index) in blocks" :key="index">
      <h4 v-if="block.type === 'h2'" class="report-markdown__h2">
        <ReportInline :segments="block.segments ?? []" />
      </h4>
      <h5 v-else-if="block.type === 'h3'" class="report-markdown__h3">
        <ReportInline :segments="block.segments ?? []" />
      </h5>
      <ul v-else-if="block.type === 'list'" class="report-markdown__list">
        <li v-for="(item, index_) in block.items" :key="index_">
          <ReportInline :segments="item" />
        </li>
      </ul>
      <blockquote v-else-if="block.type === 'quote'" class="report-markdown__quote">
        <ReportInline :segments="block.segments ?? []" />
      </blockquote>
      <p v-else class="report-markdown__p">
        <ReportInline :segments="block.segments ?? []" />
      </p>
    </template>
  </div>
</template>

<style scoped lang="scss">
.report-markdown {
  font-size: 13px;
  line-height: 1.7;
  color: var(--tp-text-primary);

  &__h2 {
    margin: 16px 0 8px;
    padding-bottom: 6px;
    font-size: 15px;
    font-weight: 700;
    color: var(--tp-text-primary);
    border-bottom: 1px solid var(--tp-border-color);

    &:first-child {
      margin-top: 0;
    }
  }

  &__h3 {
    margin: 12px 0 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__p {
    margin: 6px 0;
    overflow-wrap: anywhere;
  }

  &__list {
    margin: 6px 0;
    padding-left: 20px;

    li {
      margin: 2px 0;
      overflow-wrap: anywhere;
    }
  }

  &__quote {
    margin: 8px 0;
    padding: 6px 10px;
    font-size: 12px;
    color: var(--tp-text-tertiary);
    background: var(--tp-bg-hover);
    border-left: 3px solid var(--tp-border-color);
    border-radius: 4px;
  }
}
</style>
