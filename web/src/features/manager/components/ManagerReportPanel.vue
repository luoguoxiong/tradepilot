<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

import ReportMarkdown from './ReportMarkdown.vue'
import type {
  ManagerReportDetail,
  ManagerReportListItem,
  ManagerReportPeriod,
} from '@/api/types/manager'
import { MANAGER_REPORT_PERIODS } from '@/api/types/manager'
import { useAuthStore } from '@/stores/auth'
import { useDictStore } from '@/stores/dict'
import { formatInOrgTz } from '@/utils/date'

/**
 * 13 §1.4 经营报告：手动生成（日报/周报/月报）+ 列表 + 详情抽屉（五段 Markdown）。
 * 生成后抽屉自动打开并按 3s 节奏轮询，直到 ready / failed。
 */
const props = withDefaults(
  defineProps<{
    reports: ManagerReportListItem[]
    total: number
    loading?: boolean
    period: ManagerReportPeriod
    filter: ManagerReportPeriod | 'all'
    page: number
    pageSize?: number
    generating?: boolean
    openedId?: string | null
    detail?: ManagerReportDetail | null
    detailLoading?: boolean
  }>(),
  {
    loading: false,
    pageSize: 10,
    generating: false,
    openedId: null,
    detail: null,
    detailLoading: false,
  },
)

const emit = defineEmits<{
  'update:period': [value: ManagerReportPeriod]
  'update:filter': [value: ManagerReportPeriod | 'all']
  'update:page': [value: number]
  generate: []
  open: [reportId: string]
  close: []
}>()

const { t } = useI18n()
const router = useRouter()
const dict = useDictStore()
const auth = useAuthStore()

/** 抽屉可见性由「已打开报告 id」驱动（关闭时清空，避免残留上一次内容） */
const drawerVisible = computed({
  get: () => props.openedId !== null,
  set: (value: boolean) => {
    if (!value) emit('close')
  },
})

const drawerTitle = computed(() => {
  const detail = props.detail
  if (!detail) return t('manager.report.content')
  return `${t(`manager.report.periodLabel.${detail.period}`)} · ${detail.periodStart} ~ ${detail.periodEnd}`
})

/** citations 由核心模板 `buildBusinessReportCitations` 生成：`{ text, source?, ref? }`（发现证据去重） */
const citations = computed(() =>
  (props.detail?.citations ?? [])
    .map((item) => ({
      text: typeof item['text'] === 'string' ? item['text'] : '',
      source: typeof item['source'] === 'string' ? item['source'] : '',
      ref: typeof item['ref'] === 'string' ? item['ref'] : '',
    }))
    .filter((item) => item.text.length > 0),
)

function openRef(ref: string) {
  if (ref) void router.push(ref)
}

function generatedAt(value: string | null): string {
  return value ? formatInOrgTz(value, auth.org?.timezone, 'YYYY-MM-DD HH:mm') : '—'
}
</script>

<template>
  <el-card shadow="never" class="manager-report">
    <template #header>
      <div class="manager-report__header">
        <span class="manager-report__title">{{ t('manager.report.title') }}</span>
        <div class="manager-report__actions">
          <el-select
            :model-value="props.filter"
            size="small"
            style="width: 120px"
            @update:model-value="emit('update:filter', $event as ManagerReportPeriod | 'all')"
          >
            <el-option value="all" :label="t('manager.report.periodLabel.all')" />
            <el-option
              v-for="item in MANAGER_REPORT_PERIODS"
              :key="item"
              :value="item"
              :label="t(`manager.report.periodLabel.${item}`)"
            />
          </el-select>
          <el-select
            :model-value="props.period"
            size="small"
            style="width: 120px"
            @update:model-value="emit('update:period', $event as ManagerReportPeriod)"
          >
            <el-option
              v-for="item in MANAGER_REPORT_PERIODS"
              :key="item"
              :value="item"
              :label="t(`manager.report.periodLabel.${item}`)"
            />
          </el-select>
          <el-button
            type="primary"
            size="small"
            :loading="props.generating"
            @click="emit('generate')"
          >
            {{ t('manager.report.generate') }}
          </el-button>
        </div>
      </div>
    </template>

    <el-table
      v-loading="props.loading"
      :data="props.reports"
      size="small"
      :empty-text="t('manager.report.empty')"
      data-testid="manager-report-table"
    >
      <el-table-column :label="t('manager.report.period')" width="120">
        <template #default="{ row }">
          {{ t(`manager.report.periodLabel.${row.period}`) }}
        </template>
      </el-table-column>
      <el-table-column label="区间" min-width="180">
        <template #default="{ row }">{{ row.periodStart }} ~ {{ row.periodEnd }}</template>
      </el-table-column>
      <el-table-column :label="t('manager.report.status')" width="110">
        <template #default="{ row }">
          <span :style="{ color: dict.color('managerReportStatus', row.status) }">
            {{ dict.label('managerReportStatus', row.status) }}
          </span>
        </template>
      </el-table-column>
      <el-table-column :label="t('manager.report.generatedAt')" width="170">
        <template #default="{ row }">{{ generatedAt(row.generatedAt) }}</template>
      </el-table-column>
      <el-table-column :label="t('manager.report.action')" width="90" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="emit('open', row.reportId)">
            {{ t('manager.report.view') }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      v-if="props.total > props.pageSize"
      class="manager-report__pager"
      layout="total, prev, pager, next"
      :total="props.total"
      :current-page="props.page"
      :page-size="props.pageSize"
      @current-change="emit('update:page', $event)"
    />

    <el-drawer v-model="drawerVisible" :title="drawerTitle" size="640px">
      <el-skeleton v-if="props.detailLoading" :rows="8" animated />
      <template v-else-if="props.detail">
        <el-alert
          v-if="props.detail.status === 'generating'"
          type="info"
          :closable="false"
          :title="t('manager.report.generating')"
          show-icon
        />
        <el-alert
          v-else-if="props.detail.status === 'failed'"
          type="error"
          :closable="false"
          :title="t('manager.report.failed')"
          show-icon
        />
        <ReportMarkdown v-else :content="props.detail.content" />

        <div v-if="citations.length" class="manager-report__citations">
          <span class="manager-report__citations-label">{{ t('manager.report.citations') }}</span>
          <ul class="manager-report__citations-list">
            <li v-for="(citation, index) in citations" :key="index">
              {{ citation.text }}
              <span v-if="citation.source" class="manager-report__citation-ref">
                {{ citation.source }}
              </span>
              <el-button
                v-if="citation.ref"
                link
                type="primary"
                size="small"
                @click="openRef(citation.ref)"
              >
                {{ t('manager.discovery.viewDetail') }}
              </el-button>
            </li>
          </ul>
        </div>
      </template>
    </el-drawer>
  </el-card>
</template>

<style scoped lang="scss">
.manager-report {
  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }

  &__title {
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__actions {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  &__pager {
    margin-top: 12px;
    justify-content: flex-end;
  }

  &__citations {
    margin-top: 16px;
    padding-top: 12px;
    border-top: 1px solid var(--tp-border-color);
  }

  &__citations-label {
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__citations-list {
    margin: 6px 0 0;
    padding-left: 18px;
    font-size: 12px;
    line-height: 1.8;
    color: var(--tp-text-secondary);

    li {
      overflow-wrap: anywhere;
    }
  }

  &__citation-ref {
    margin-left: 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--tp-text-tertiary);
  }
}
</style>
