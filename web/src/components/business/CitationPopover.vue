<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

import { getKnowledgeDocument } from '@/api/resources/knowledge'
import type { InsightCitation } from '@/api/types/insight'
import type { KnowledgeDocument } from '@/api/types/knowledge'
import { DEFAULT_TIMEZONE, formatInOrgTz } from '@/utils/date'
import { ENUMS } from '@/utils/enum-map'

/**
 * CitationPopover 引用溯源弹层（04 §2.2）：
 * citation（docId/docName/chunkId）→ 首次打开按 docId 解析文档信息（分类/上传人/时间，
 * 11 §3.5），软删文档（doc.deleted）标记「已删除」并禁再跳转（P1-5 留痕口径）。
 * 自研轻量锚定弹层（Teleport + fixed）：可安全内嵌于 el-popover/表格等任何上下文。
 */
const props = withDefaults(
  defineProps<{
    citation: InsightCitation
    /** 原文路由地址（知识中心等落地后传入）；软删/解析失败时禁用 */
    jumpTo?: string
    width?: number
  }>(),
  { jumpTo: undefined, width: 320 },
)

const { t } = useI18n()

const triggerRef = ref<HTMLElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)
const visible = ref(false)
const panelStyle = ref({ top: '0px', left: '0px', width: `${props.width}px` })

/** idle | loading | ready | error（同 docId 仅解析一次，缓存命中不重复请求） */
type ResolveState = 'idle' | 'loading' | 'ready' | 'error'
const state = ref<ResolveState>('idle')
const doc = ref<KnowledgeDocument | null>(null)
let resolvedDocId: string | null = null

async function ensureLoaded() {
  if (resolvedDocId === props.citation.docId || state.value === 'loading') return
  state.value = 'loading'
  try {
    doc.value = await getKnowledgeDocument(props.citation.docId)
    resolvedDocId = props.citation.docId
    state.value = 'ready'
  } catch {
    resolvedDocId = props.citation.docId
    state.value = 'error'
  }
}

const categoryOption = computed(() => {
  const category = doc.value?.category
  if (!category) return undefined
  return ENUMS.knowledgeCategory.find((o) => o.value === category)
})

const isDeleted = computed(() => state.value === 'ready' && doc.value?.deleted === true)
const canJump = computed(() => !!props.jumpTo && state.value === 'ready' && !doc.value?.deleted)

function position() {
  const anchor = triggerRef.value
  const panel = panelRef.value
  if (!anchor || !panel) return
  const rect = anchor.getBoundingClientRect()
  const viewportW = document.documentElement.clientWidth
  const viewportH = window.innerHeight
  const left = Math.max(8, Math.min(rect.left, viewportW - props.width - 8))
  let top = rect.bottom + 6
  const panelH = panel.offsetHeight
  // 下方空间不足时向上翻转（简单测量一次，避免越界）
  if (rect.bottom + 6 + panelH > viewportH - 8 && rect.top > panelH + 6) {
    top = Math.max(8, rect.top - panelH - 6)
  }
  panelStyle.value = { top: `${top}px`, left: `${left}px`, width: `${props.width}px` }
}

let cleanup: (() => void) | null = null

async function open() {
  if (visible.value) return
  visible.value = true
  await ensureLoaded()
  await nextTick()
  position()

  const onPointerDown = (e: PointerEvent) => {
    const target = e.target as Node
    if (triggerRef.value?.contains(target)) return
    if (panelRef.value?.contains(target)) return
    close()
  }
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close()
  }
  const onViewportChange = () => close()
  window.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('scroll', onViewportChange, true)
  cleanup = () => {
    window.removeEventListener('pointerdown', onPointerDown)
    window.removeEventListener('keydown', onKeydown)
    window.removeEventListener('resize', onViewportChange)
    window.removeEventListener('scroll', onViewportChange, true)
  }
}

function close() {
  visible.value = false
  cleanup?.()
  cleanup = null
}

function toggle() {
  if (visible.value) close()
  else void open()
}

function handleTriggerKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    toggle()
  }
}

// 跳转原文：懒取 router（避免未安装时初始化报错），缺省回退浏览器导航
function jump() {
  if (!canJump.value) return
  if (props.jumpTo) {
    const router = useRouter()
    if (router) void router.push(props.jumpTo)
    else window.location.assign(props.jumpTo)
  }
}

onBeforeUnmount(close)

defineExpose({ open, close })
</script>

<template>
  <span class="citation-popover">
    <!-- 默认插槽 = 触发器内容（无则回退 docName） -->
    <span
      ref="triggerRef"
      class="citation-popover__trigger"
      role="button"
      tabindex="0"
      :aria-expanded="visible"
      @click.stop="toggle"
      @keydown="handleTriggerKeydown"
    >
      <slot>{{ props.citation.docName }}</slot>
    </span>

    <Teleport to="body">
      <Transition name="citation-fade">
        <div
          v-if="visible"
          ref="panelRef"
          class="citation-popover__panel"
          :style="panelStyle"
          role="tooltip"
        >
          <!-- 头部：文件名 + 已删标记 -->
          <div class="citation-popover__header">
            <span class="citation-popover__doc-icon" aria-hidden="true" />
            <span class="citation-popover__name" :title="props.citation.docName">
              {{ props.citation.docName }}
            </span>
            <span v-if="isDeleted" class="citation-popover__deleted">{{
              t('citation.deleted')
            }}</span>
          </div>

          <!-- 加载 / 失败 -->
          <div v-if="state === 'loading'" class="citation-popover__placeholder">
            {{ t('common.loading') }}
          </div>
          <div v-else-if="state === 'error'" class="citation-popover__error">
            {{ t('citation.unavailable') }}
          </div>

          <template v-else-if="state === 'ready'">
            <!-- 软删留痕说明：历史引用仅作回溯（11 §3.4 / P1-5） -->
            <p v-if="isDeleted" class="citation-popover__deleted-tip">
              {{ t('citation.deletedTip') }}
            </p>

            <dl class="citation-popover__meta">
              <div v-if="categoryOption" class="citation-popover__row">
                <dt>{{ t('citation.category') }}</dt>
                <dd>
                  <span
                    class="citation-popover__dot"
                    :style="{ background: categoryOption.color ?? 'var(--ai-idle)' }"
                  />
                  {{ t(categoryOption.labelKey) }}
                </dd>
              </div>
              <div v-if="doc?.updatedBy" class="citation-popover__row">
                <dt>{{ t('citation.uploader') }}</dt>
                <dd>{{ doc.updatedBy }}</dd>
              </div>
              <div v-if="doc?.uploadedAt" class="citation-popover__row">
                <dt>{{ t('citation.uploadedAt') }}</dt>
                <dd>{{ formatInOrgTz(doc.uploadedAt, DEFAULT_TIMEZONE, 'YYYY-MM-DD HH:mm') }}</dd>
              </div>
              <div v-if="props.citation.chunkId" class="citation-popover__row">
                <dt>{{ t('citation.chunk') }}</dt>
                <dd class="citation-popover__mono">{{ props.citation.chunkId }}</dd>
              </div>
            </dl>

            <!-- 跳转原文：软删/不可解析时禁跳（04 §2.1） -->
            <button v-if="canJump" type="button" class="citation-popover__jump" @click="jump">
              {{ t('citation.jump') }}
            </button>
          </template>
        </div>
      </Transition>
    </Teleport>
  </span>
</template>

<style scoped lang="scss">
.citation-popover {
  display: inline-flex;

  &__trigger {
    display: inline-flex;
    align-items: center;
    max-width: 100%;
    cursor: pointer;
    outline: none;
    border-radius: 4px;

    &:focus-visible {
      box-shadow: 0 0 0 2px var(--tp-primary);
    }
  }

  &__panel {
    position: fixed;
    z-index: 3000;
    padding: 12px;
    border: 1px solid var(--tp-border-color);
    border-radius: var(--tp-border-radius-base);
    background: var(--tp-bg-container);
    box-shadow: 0 6px 16px rgb(0 0 0 / 10%);
    font-size: 13px;
    box-sizing: border-box;
  }

  &__header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
  }

  &__doc-icon {
    width: 14px;
    height: 16px;
    flex-shrink: 0;
    border: 1px solid var(--tp-text-tertiary);
    border-radius: 2px;
    position: relative;

    &::after {
      content: '';
      position: absolute;
      inset: 3px 2px;
      border-top: 1px dashed var(--tp-text-tertiary);
    }
  }

  &__name {
    min-width: 0;
    font-weight: 600;
    color: var(--tp-text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__deleted {
    flex-shrink: 0;
    padding: 0 6px;
    line-height: 18px;
    font-size: 12px;
    color: #fff;
    background: var(--ai-risk);
    border-radius: 4px;
  }

  &__deleted-tip {
    margin: 0 0 8px;
    padding: 6px 8px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--tp-text-tertiary);
    background: var(--tp-bg-hover);
    border-radius: 4px;
  }

  &__placeholder,
  &__error {
    padding: 4px 0;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__error {
    color: var(--ai-risk);
  }

  &__meta {
    margin: 0;
  }

  &__row {
    display: flex;
    gap: 10px;
    margin: 4px 0;

    dt {
      width: 64px;
      flex-shrink: 0;
      color: var(--tp-text-tertiary);
      font-weight: 400;
    }

    dd {
      margin: 0;
      min-width: 0;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      color: var(--tp-text-primary);
      overflow-wrap: anywhere;
    }
  }

  &__dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  &__mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }

  &__jump {
    margin-top: 8px;
    padding: 0;
    border: none;
    background: none;
    font-size: 13px;
    color: var(--tp-primary);
    cursor: pointer;

    &:hover {
      color: var(--tp-primary-hover);
      text-decoration: underline;
    }
  }
}

.citation-fade-enter-active,
.citation-fade-leave-active {
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}

.citation-fade-enter-from,
.citation-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
