<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import EmptyState from '@/components/business/EmptyState.vue'
import type { AnalyticsMetric, TrendPoint } from '@/api/types/analytics'

/**
 * 客户增长趋势折线图（15 §1.3 趋势图 + §3.1）。
 * 无图表依赖：内联 SVG 三序列折线 + 悬浮读数；图例可点击下钻对应 metric（15 §4 可下钻验证）。
 */
const props = withDefaults(defineProps<{ points: TrendPoint[]; loading?: boolean }>(), {
  loading: false,
})

const emit = defineEmits<{ drilldown: [metric: AnalyticsMetric] }>()

const { t } = useI18n()

const SVG_W = 720
const SVG_H = 240
const PAD = { top: 16, right: 16, bottom: 30, left: 44 }

const SERIES = [
  {
    key: 'newCustomers',
    metric: 'new_customers',
    labelKey: 'dataCenter.metric.newCustomers',
    color: 'var(--el-color-primary)',
  },
  {
    key: 'newInquiries',
    metric: 'inquiries',
    labelKey: 'dataCenter.metric.inquiries',
    color: 'var(--ai-working)',
  },
  {
    key: 'newQuotes',
    metric: 'new_quotes',
    labelKey: 'dataCenter.metric.newQuotes',
    color: 'var(--ai-waiting)',
  },
] as const satisfies readonly {
  key: 'newCustomers' | 'newInquiries' | 'newQuotes'
  metric: AnalyticsMetric
  labelKey: string
  color: string
}[]

const innerW = SVG_W - PAD.left - PAD.right
const innerH = SVG_H - PAD.top - PAD.bottom

const maxValue = computed(() =>
  Math.max(1, ...props.points.flatMap((p) => [p.newCustomers, p.newInquiries, p.newQuotes])),
)

const stepX = computed(() =>
  props.points.length > 1 ? innerW / (props.points.length - 1) : innerW,
)

function xAt(index: number): number {
  if (props.points.length <= 1) return PAD.left + innerW / 2
  return PAD.left + index * stepX.value
}

function yAt(value: number): number {
  return PAD.top + innerH - (value / maxValue.value) * innerH
}

function pathOf(key: 'newCustomers' | 'newInquiries' | 'newQuotes'): string {
  return props.points
    .map(
      (point, index) =>
        `${index === 0 ? 'M' : 'L'}${xAt(index).toFixed(1)},${yAt(point[key]).toFixed(1)}`,
    )
    .join(' ')
}

const yTicks = computed(() =>
  [1, 0.5, 0].map((ratio) => ({
    value: Math.round(maxValue.value * ratio),
    y: yAt(maxValue.value * ratio),
  })),
)

/** x 轴标签抽稀：最多约 7 个 */
const labelStep = computed(() => Math.max(1, Math.ceil(props.points.length / 7)))

const hoverIndex = ref<number | null>(null)

const hoverPoint = computed(() =>
  hoverIndex.value === null ? null : (props.points[hoverIndex.value] ?? null),
)

const hoverX = computed(() => (hoverIndex.value === null ? 0 : xAt(hoverIndex.value)))

function hitRect(index: number): { x: number; width: number } {
  const half = stepX.value / 2
  const x = Math.max(PAD.left, xAt(index) - half)
  const right = Math.min(SVG_W - PAD.right, xAt(index) + half)
  return { x, width: Math.max(1, right - x) }
}
</script>

<template>
  <div class="trend">
    <div class="trend__legend">
      <button
        v-for="series in SERIES"
        :key="series.key"
        type="button"
        class="trend__legend-item"
        :title="t('dataCenter.drilldownHint')"
        @click="emit('drilldown', series.metric)"
      >
        <i class="trend__dot" :style="{ background: series.color }" />
        {{ t(series.labelKey) }}
      </button>
    </div>

    <EmptyState v-if="props.points.length === 0 && !props.loading" />
    <div v-else class="trend__canvas">
      <svg :viewBox="`0 0 ${SVG_W} ${SVG_H}`" class="trend__svg" role="img">
        <!-- y 轴刻度 + 网格 -->
        <g>
          <line
            v-for="tick in yTicks"
            :key="tick.y"
            :x1="PAD.left"
            :x2="SVG_W - PAD.right"
            :y1="tick.y"
            :y2="tick.y"
            class="trend__grid"
          />
          <text
            v-for="tick in yTicks"
            :key="`label-${tick.y}`"
            :x="PAD.left - 8"
            :y="tick.y + 4"
            class="trend__axis"
            text-anchor="end"
          >
            {{ tick.value }}
          </text>
        </g>

        <!-- x 轴标签（抽稀） -->
        <text
          v-for="(point, index) in props.points"
          v-show="index % labelStep === 0 || index === props.points.length - 1"
          :key="point.date"
          :x="xAt(index)"
          :y="SVG_H - 8"
          class="trend__axis"
          text-anchor="middle"
        >
          {{ point.date.slice(5) }}
        </text>

        <!-- 悬浮参考线 -->
        <line
          v-if="hoverIndex !== null"
          :x1="hoverX"
          :x2="hoverX"
          :y1="PAD.top"
          :y2="PAD.top + innerH"
          class="trend__guide"
        />

        <!-- 折线 -->
        <path
          v-for="series in SERIES"
          :key="series.key"
          :d="pathOf(series.key)"
          :stroke="series.color"
          class="trend__line"
        />
        <g v-if="hoverPoint">
          <circle
            v-for="series in SERIES"
            :key="`dot-${series.key}`"
            :cx="hoverX"
            :cy="yAt(hoverPoint[series.key])"
            :fill="series.color"
            r="3.5"
          />
        </g>

        <!-- 命中区（悬浮读数） -->
        <rect
          v-for="(point, index) in props.points"
          :key="`hit-${point.date}`"
          :x="hitRect(index).x"
          :width="hitRect(index).width"
          :y="PAD.top"
          :height="innerH"
          class="trend__hit"
          @mouseenter="hoverIndex = index"
          @mouseleave="hoverIndex = null"
        />
      </svg>

      <div v-if="hoverPoint" class="trend__tip" :style="{ left: `${(hoverX / SVG_W) * 100}%` }">
        <span class="trend__tip-date">{{ hoverPoint.date }}</span>
        <span v-for="series in SERIES" :key="series.key" class="trend__tip-row">
          <i class="trend__dot" :style="{ background: series.color }" />
          {{ t(series.labelKey) }}
          <strong>{{ hoverPoint[series.key] }}</strong>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.trend {
  &__legend {
    display: flex;
    gap: 16px;
    margin-bottom: 4px;
  }

  &__legend-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 4px;
    font-size: 13px;
    color: var(--tp-text-secondary);
    background: none;
    border: none;
    cursor: pointer;

    &:hover {
      color: var(--el-color-primary);
    }
  }

  &__dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
  }

  &__canvas {
    position: relative;
  }

  &__svg {
    width: 100%;
    height: auto;
    display: block;
  }

  &__grid {
    stroke: var(--tp-border-light, #ebeef5);
    stroke-width: 1;
  }

  &__guide {
    stroke: var(--tp-text-tertiary);
    stroke-width: 1;
    stroke-dasharray: 3 3;
  }

  &__line {
    fill: none;
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
  }

  &__axis {
    font-size: 11px;
    fill: var(--tp-text-tertiary);
  }

  &__hit {
    fill: transparent;
    cursor: crosshair;
  }

  &__tip {
    position: absolute;
    top: 8px;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 10px;
    background: var(--el-bg-color-overlay, #fff);
    border: 1px solid var(--tp-border-light, #ebeef5);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgb(0 0 0 / 8%);
    font-size: 12px;
    white-space: nowrap;
    pointer-events: none;
  }

  &__tip-date {
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__tip-row {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--tp-text-secondary);

    strong {
      color: var(--tp-text-primary);
    }
  }
}
</style>
