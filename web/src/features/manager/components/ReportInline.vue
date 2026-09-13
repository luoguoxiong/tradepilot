<script setup lang="ts">
import type { ReportSegment } from '../report-inline'

/**
 * 报告行内片段渲染（13 §1.4）：内部路径走 vue-router（不整页刷新），外部地址新窗口打开。
 */
defineProps<{ segments: ReportSegment[] }>()

function isExternal(href: string): boolean {
  return /^https?:\/\//i.test(href)
}
</script>

<template>
  <template v-for="(segment, index) in segments" :key="index">
    <a
      v-if="segment.href && isExternal(segment.href)"
      class="report-inline__link"
      :href="segment.href"
      target="_blank"
      rel="noopener noreferrer"
    >
      {{ segment.text }}
    </a>
    <RouterLink v-else-if="segment.href" class="report-inline__link" :to="segment.href">
      {{ segment.text }}
    </RouterLink>
    <template v-else>{{ segment.text }}</template>
  </template>
</template>

<style scoped lang="scss">
.report-inline__link {
  color: var(--tp-primary);
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
}
</style>
