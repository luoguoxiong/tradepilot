<script setup lang="ts" generic="T extends object">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'

import FilterBar, { type FilterField } from '@/components/business/FilterBar.vue'
import ScopeSelect from '@/components/business/ScopeSelect.vue'
import EmptyState from '@/components/business/EmptyState.vue'
import { useDictStore } from '@/stores/dict'
import { listQueryOptions } from '@/query/options'
import type { ProColumn } from '@/components/business/pro-table'
import type { DataScope, PageResp } from '@/api/types/common'
import { usePermission } from '@/composables/usePermission'

/** el-table sort-change 事件参数（本地结构化，避免依赖内部类型导出） */
interface SortChangeParams {
  prop: string
  order: 'ascending' | 'descending' | null
}

/**
 * ProTable 列表页统一承载（02 §4.1）：
 * - 列 schema / 筛选 schema（FilterBar）/ 分页排序参数对齐接口规范 §2.3；
 * - vue-query 驱动：query key 含全量参数，keepPreviousData 防翻页/筛选抖动；
 * - 内置 ScopeSelect（按角色显隐）、多选批量操作条、统一空态。
 */
const props = withDefaults(
  defineProps<{
    columns: ProColumn[]
    fetcher: (params: Record<string, unknown>) => Promise<PageResp<T>>
    /** vue-query key 基座（模块内唯一），实际 key = [...base, query] */
    queryKeyBase: readonly unknown[]
    filters?: FilterField[]
    rowKey?: string
    selectable?: boolean
    /** 数据范围选择器（05 §2；sales 自隐藏） */
    scopeable?: boolean
    defaultQuery?: Record<string, unknown>
    /** 外部受控筛选（如页签 Tab），合并进 query key（优先级高于 filters） */
    externalQuery?: Record<string, unknown>
    pageSize?: number
    /** 列表不启用关键词搜索时可关 */
    searchable?: boolean
  }>(),
  {
    filters: () => [],
    rowKey: 'id',
    selectable: false,
    scopeable: false,
    defaultQuery: () => ({}),
    pageSize: 20,
    searchable: true,
  },
)

const emit = defineEmits<{
  'selection-change': [rows: T[]]
  'row-click': [row: T]
}>()

const { t } = useI18n()
const dict = useDictStore()

// ===== query 状态（筛选/分页/排序/scope 全量进 key）=====
const page = ref(1)
const filterValues = ref<Record<string, unknown>>({ ...props.defaultQuery })
const sortBy = ref<string | undefined>(undefined)
const sortOrder = ref<'asc' | 'desc' | undefined>(undefined)
// scope 默认取角色上限（05 §2：admin→all、manager→team、sales→self）
const { maxScope } = usePermission()
const scope = ref<DataScope>(maxScope.value)
const keyword = ref<string | undefined>(undefined)

const query = computed<Record<string, unknown>>(() => ({
  ...filterValues.value,
  ...props.externalQuery,
  page: page.value,
  pageSize: props.pageSize,
  sortBy: sortBy.value,
  sortOrder: sortOrder.value,
  scope: props.scopeable ? scope.value : undefined,
  keyword: keyword.value,
}))

const queryKey = computed(() => [...props.queryKeyBase, query.value])

const { data, isFetching, isLoading } = useQuery({
  queryKey,
  queryFn: () => props.fetcher(query.value),
  ...listQueryOptions(),
})

const rows = computed<T[]>(() => data.value?.items ?? [])
const total = computed(() => data.value?.total ?? 0)

function onSortChange(sort: SortChangeParams) {
  if (sort.prop && sort.order) {
    sortBy.value = sort.prop
    sortOrder.value = sort.order === 'ascending' ? 'asc' : 'desc'
  } else {
    sortBy.value = undefined
    sortOrder.value = undefined
  }
}

// ===== 批量选择 =====
const tableRef = ref()
const selected = ref<T[]>([])

watch(
  () => rows.value,
  () => {
    // 数据刷新后清空已选（行集合可能已变化）
    tableRef.value?.clearSelection()
    selected.value = []
  },
)

function onSelectionChange(rowsSelected: T[]) {
  selected.value = rowsSelected
  emit('selection-change', rowsSelected)
}

function onRowClick(row: T) {
  emit('row-click', row)
}

/** 供批量操作完成后清选择 */
function clearSelection() {
  tableRef.value?.clearSelection()
  selected.value = []
}

/** 外部手动刷新（操作后 invalidate 由调用方负责；此处翻页重置便捷方法） */
function resetToFirstPage() {
  page.value = 1
}

defineExpose({ clearSelection, resetToFirstPage, selected })

function columnValue(row: unknown, prop: string): unknown {
  return (row as Record<string, unknown>)[prop]
}

/** 枚举列渲染（dictStore：label + 语义色） */
function enumLabel(col: ProColumn, row: unknown): string {
  return col.enumGroup ? dict.label(col.enumGroup, String(columnValue(row, col.prop) ?? '')) : ''
}

function enumColor(col: ProColumn, row: unknown): string {
  return col.enumGroup
    ? (dict.color(col.enumGroup, String(columnValue(row, col.prop))) ?? 'var(--ai-idle)')
    : ''
}
</script>

<template>
  <div class="pro-table" v-loading="isLoading">
    <div class="pro-table__toolbar">
      <FilterBar v-if="props.filters.length" :fields="props.filters" v-model="filterValues">
        <el-input
          v-if="props.searchable"
          v-model="keyword"
          :placeholder="t('proTable.keyword')"
          clearable
          style="width: 220px"
          @clear="keyword = undefined"
        />
        <slot name="filters" />
      </FilterBar>
      <div class="pro-table__toolbar-right">
        <slot name="toolbar" />
        <ScopeSelect v-if="props.scopeable" v-model="scope" />
      </div>
    </div>

    <!-- 批量操作条（02 §4.1：多选 → 底部操作条） -->
    <div v-if="props.selectable && selected.length > 0" class="pro-table__batch">
      <span class="pro-table__batch-count">
        {{ t('proTable.selected', { count: selected.length }) }}
      </span>
      <slot name="batch" :rows="selected" :clear="clearSelection" />
    </div>

    <el-table
      ref="tableRef"
      :data="rows"
      :row-key="props.rowKey"
      stripe
      @sort-change="onSortChange"
      @selection-change="onSelectionChange"
      @row-click="onRowClick"
    >
      <el-table-column v-if="props.selectable" type="selection" width="42" fixed="left" />
      <el-table-column
        v-for="col in props.columns"
        :key="col.prop"
        :prop="col.prop"
        :label="t(col.labelKey)"
        :width="col.width"
        :min-width="col.minWidth"
        :sortable="col.sortable"
        :fixed="col.fixed"
        :align="col.align"
      >
        <template v-if="col.enumGroup" #default="{ row }">
          <span class="pro-table__enum" :style="{ color: enumColor(col, row) }">
            {{ enumLabel(col, row) }}
          </span>
        </template>
        <template v-else #default="{ row }">
          <slot :name="`col-${col.prop}`" :row="row" :value="columnValue(row, col.prop)">
            {{ columnValue(row, col.prop) ?? '—' }}
          </slot>
        </template>
      </el-table-column>
      <template #empty>
        <EmptyState />
      </template>
    </el-table>

    <div class="pro-table__pager">
      <el-pagination
        v-model:current-page="page"
        :page-size="props.pageSize"
        :total="total"
        layout="total, prev, pager, next"
        :background="true"
      />
      <span v-if="isFetching" class="pro-table__fetching">{{ t('common.loading') }}</span>
    </div>
  </div>
</template>

<style scoped lang="scss">
.pro-table {
  &__toolbar {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }

  &__toolbar-right {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  &__batch {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    margin-bottom: 8px;
    background: var(--el-color-primary-light-9);
    border-radius: var(--tp-radius-base, 8px);
  }

  &__batch-count {
    font-size: 13px;
    color: var(--el-color-primary);
    font-weight: 500;
  }

  &__enum {
    font-weight: 500;
  }

  &__pager {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 12px;
    margin-top: 12px;
  }

  &__fetching {
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }
}
</style>
