<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * 自研水平分栏容器（06 §2 三栏工作台）：拖拽分隔条调整相邻 Pane 宽度占比。
 * - sizes 为百分比数组（和恒为 100），v-model:sizes 双向绑定；
 * - storageKey 提供时拖拽结束持久化 localStorage，重进恢复；
 * - 嵌套组合实现三栏以上（inbox 左列表 | 右侧再嵌套 会话|Copilot）；
 * - Pointer Events 统一鼠标/触摸，拖拽中 pointer capture 防止丢事件。
 */
const props = withDefaults(
  defineProps<{
    /** 受控宽度百分比（可选）：传入则受控（v-model:sizes），缺省内部自治 */
    sizes?: number[]
    /** 初始宽度百分比（left..right，和 100），外部未传时使用 */
    initial?: number[]
    /** 各 Pane 最小宽度百分比，默认 10% */
    min?: number[]
    /** localStorage 持久化键（拖拽结束写入） */
    storageKey?: string
  }>(),
  { sizes: undefined, initial: () => [50, 50], min: () => [], storageKey: undefined },
)

const emit = defineEmits<{ 'update:sizes': [sizes: number[]] }>()

const innerSizes = ref<number[]>(props.storageKey ? restore() : [...props.initial])
const draggingIndex = ref<number | null>(null)

const containerRef = ref<HTMLElement | null>(null)

const sizes = computed<number[]>(() => props.sizes ?? innerSizes.value)

function restore(): number[] {
  try {
    const raw = localStorage.getItem(`splitpanes:${props.storageKey}`)
    const parsed = raw ? (JSON.parse(raw) as number[]) : null
    if (parsed && parsed.length === props.initial.length) return parsed
  } catch {
    /* 忽略损坏缓存 */
  }
  return [...props.initial]
}

function persist(): void {
  if (!props.storageKey) return
  try {
    localStorage.setItem(`splitpanes:${props.storageKey}`, JSON.stringify(innerSizes.value))
  } catch {
    /* 存储满/隐私模式静默 */
  }
}

/** 拖拽第 index 条分隔条（位于 pane index 与 index+1 之间） */
function onDividerDown(index: number, event: PointerEvent): void {
  draggingIndex.value = index
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function onDividerMove(event: PointerEvent): void {
  const index = draggingIndex.value
  const container = containerRef.value
  if (index === null || !container) return
  const rect = container.getBoundingClientRect()
  if (rect.width <= 0) return

  const next = [...sizes.value]
  const minI = props.min[index] ?? 10
  const minJ = props.min[index + 1] ?? 10
  const dividerW = 100 / next.length // 分隔条占位近似补偿

  // 指针位置 → 相对左侧分隔条起点的位移百分比
  const dividerLeftPct =
    next.slice(0, index).reduce((sum, s) => sum + s, 0) + (index + 0.5) * dividerW
  const deltaPct = ((event.clientX - rect.left) / rect.width) * 100 - dividerLeftPct

  let a = next[index] + deltaPct
  let b = next[index + 1] - deltaPct
  // 最小宽度夹取（优先保证先触碰的一侧）
  if (a < minI) {
    a = minI
    b = next[index] + next[index + 1] - a
  } else if (b < minJ) {
    b = minJ
    a = next[index] + next[index + 1] - b
  }
  next[index] = a
  next[index + 1] = b
  if (props.sizes) emit('update:sizes', next)
  else innerSizes.value = next
}

function onDividerUp(): void {
  if (draggingIndex.value === null) return
  draggingIndex.value = null
  persist()
}

/** 双击分隔条：恢复该对初始占比 */
function resetPair(index: number): void {
  const next = [...sizes.value]
  next[index] = props.initial[index]
  next[index + 1] = props.initial[index + 1]
  if (props.sizes) emit('update:sizes', next)
  else innerSizes.value = next
  persist()
}

onMounted(() => {
  if (props.storageKey && props.sizes === undefined) persist()
})
onBeforeUnmount(() => {
  draggingIndex.value = null
})
</script>

<template>
  <div ref="containerRef" class="split-panes" :class="{ 'split-panes--dragging': draggingIndex !== null }">
    <template v-for="(pane, i) in sizes" :key="i">
      <div class="split-panes__pane" :style="{ flexBasis: `${pane}%` }">
        <slot :name="`pane-${i}`" />
      </div>
      <div
        v-if="i < sizes.length - 1"
        class="split-panes__divider"
        @pointerdown="onDividerDown(i, $event)"
        @pointermove="onDividerMove"
        @pointerup="onDividerUp"
        @pointercancel="onDividerUp"
        @dblclick="resetPair(i)"
      >
        <span class="split-panes__divider-dot" />
      </div>
    </template>
  </div>
</template>

<style scoped lang="scss">
.split-panes {
  display: flex;
  height: 100%;
  min-height: 0;
  overflow: hidden;

  // 拖拽中全局禁选中，防止文本高亮抖动
  &--dragging {
    cursor: col-resize;
    user-select: none;
  }

  &__pane {
    flex: 0 1 auto;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;

    > :deep(*) {
      min-height: 0;
    }
  }

  &__divider {
    flex: 0 0 5px;
    cursor: col-resize;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    transition: background 0.15s;

    &:hover,
    &:active {
      background: var(--el-color-primary-light-8);
    }
  }

  &__divider-dot {
    width: 2px;
    height: 32px;
    border-radius: 2px;
    background: var(--el-border-color);
  }
}
</style>
