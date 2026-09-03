<script setup lang="ts">
/**
 * /leads 线索列表：
 * KPI 卡（已分析/A级/B级/失败）+ 按评分排序表格（彩色评分徽章）+ 批量确认 + 状态/重试
 * 页面可见时每 1.5s 轮询刷新进行中的任务
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api, normalizeList, type Lead, type LeadStatus } from '../api/client'
import { useProfileStore } from '../stores/profile'

const store = useProfileStore()
const router = useRouter()

const leads = ref<Lead[]>([])
const loading = ref(false)
const confirming = ref(false)
const selected = ref<Lead[]>([])

/* ---- 状态与评级展示映射 ---- */
const STATUS_MAP: Record<LeadStatus | string, { label: string; tag: 'info' | 'warning' | 'success' | 'danger' }> = {
  new: { label: '新发现', tag: 'info' },
  queued: { label: '排队中', tag: 'info' },
  scraping: { label: '抓取中', tag: 'warning' },
  analyzing: { label: '分析中', tag: 'warning' },
  done: { label: '已完成', tag: 'success' },
  confirmed: { label: '已确认', tag: 'success' },
  failed: { label: '失败', tag: 'danger' }
}
/** 评分徽章底色：A绿/B蓝/C黄/D红 */
const GRADE_COLOR: Record<string, string> = {
  A: '#16a34a',
  B: '#2563eb',
  C: '#ca8a04',
  D: '#b91c1c'
}

function statusInfo(s: string) {
  return STATUS_MAP[s] ?? { label: s, tag: 'info' as const }
}
function gradeColor(grade: string | null): string {
  return grade ? GRADE_COLOR[grade] ?? '#9ca3af' : '#9ca3af'
}

/* ---- KPI ---- */
const kpi = computed(() => {
  const analyzed = leads.value.filter((l) => l.score != null)
  return {
    analyzed: analyzed.length,
    a: analyzed.filter((l) => l.grade === 'A').length,
    b: analyzed.filter((l) => l.grade === 'B').length,
    failed: leads.value.filter((l) => l.status === 'failed').length
  }
})

/** 按评分倒序（未分析/失败排最后） */
const sorted = computed(() => [...leads.value].sort((x, y) => (y.score ?? -1) - (x.score ?? -1)))

/* ---- 数据加载与轮询 ---- */
async function load(silent = false): Promise<void> {
  if (!silent) loading.value = true
  try {
    leads.value = normalizeList<Lead>(
      await api.listLeads(store.current ? { profileId: store.current.id } : undefined)
    )
  } finally {
    if (!silent) loading.value = false
  }
}

let timer: number | undefined
function startPolling(): void {
  stopPolling()
  timer = window.setInterval(() => {
    // 仅页面可见时轮询刷新进行中的任务
    if (document.visibilityState !== 'visible') return
    void load(true)
  }, 1500)
}
function stopPolling(): void {
  if (timer != null) {
    clearInterval(timer)
    timer = undefined
  }
}

onMounted(async () => {
  await load()
  startPolling()
})
onUnmounted(stopPolling)

/* ---- 操作 ---- */
function onSelectionChange(rows: unknown[]): void {
  selected.value = rows as Lead[]
}

/** 批量确认：对选中且已完成分析的线索逐个调 POST /api/leads/:id/confirm */
async function confirmSelected(): Promise<void> {
  const ids = selected.value.filter((l) => l.status === 'done' || l.status === 'confirmed').map((l) => l.id)
  if (!ids.length) {
    ElMessage.warning('请先勾选已完成分析的线索')
    return
  }
  confirming.value = true
  try {
    await Promise.all(ids.map((id) => api.confirm(id)))
    ElMessage.success(`已确认 ${ids.length} 个客户，可进入开发信生成`)
    await load(true)
  } finally {
    confirming.value = false
  }
}

/** 失败重试 → POST /api/leads/:id/retry */
async function retry(l: Lead): Promise<void> {
  await api.retry(l.id)
  ElMessage.success('已重新提交分析')
  await load(true)
}

/** 导出全部报告（CSV，含 BOM 便于 Excel 打开中文） */
function exportCsv(): void {
  const header = ['公司', '域名', '评分', '评级', '状态', '主营摘要', '联系方式', '来源query']
  const rows = sorted.value.map((l) => [
    l.company_name,
    l.domain,
    l.score ?? '',
    l.grade ?? '',
    statusInfo(l.status).label,
    l.main_business ?? '',
    l.contact ?? '',
    l.source_query ?? ''
  ])
  const csv = [header, ...rows]
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'tradepilot-leads.csv'
  a.click()
  URL.revokeObjectURL(url)
  ElMessage.success('已导出 CSV')
}
</script>

<template>
  <div>
    <!-- KPI 卡 -->
    <div class="kpi">
      <div class="card">
        <div class="num">{{ kpi.analyzed }}</div>
        <div class="lbl">已分析线索</div>
      </div>
      <div class="card">
        <div class="num">{{ kpi.a }}</div>
        <div class="lbl">A 级客户</div>
      </div>
      <div class="card">
        <div class="num">{{ kpi.b }}</div>
        <div class="lbl">B 级客户</div>
      </div>
      <div class="card">
        <div class="num danger">{{ kpi.failed }}</div>
        <div class="lbl">抓取失败（可重试）</div>
      </div>
    </div>

    <!-- 线索表格 -->
    <div class="card">
      <h2>线索列表 <span class="badge">按评分排序</span></h2>

      <el-table
        :data="sorted"
        v-loading="loading"
        row-key="id"
        @selection-change="onSelectionChange"
      >
        <el-table-column type="selection" width="42" />

        <!-- 评分：彩色徽章 + 评级标签 -->
        <el-table-column label="评分" width="120">
          <template #default="{ row }">
            <div style="display: flex; align-items: center">
              <span class="score-box" :style="{ background: gradeColor(row.grade) }">
                {{ row.score ?? '—' }}
              </span>
              <span v-if="row.grade" class="grade-tag" :class="row.grade">{{ row.grade }}</span>
              <span v-else-if="row.status === 'failed'" class="grade-tag D">失败</span>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="客户" min-width="180">
          <template #default="{ row }">
            <div class="cell-main">
              <b>{{ row.company_name }}</b>
              <span class="src">{{ row.domain }}</span>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="主营摘要" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.main_business">{{ row.main_business }}</span>
            <span v-else-if="row.status === 'failed'" class="missing">{{ row.error || '抓取失败' }}</span>
            <span v-else class="src">待分析</span>
          </template>
        </el-table-column>

        <el-table-column label="联系方式" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.contact">{{ row.contact }}</span>
            <span v-else class="src">—</span>
          </template>
        </el-table-column>

        <!-- 状态：进行中/已完成/失败（failed 展示 error 与重试） -->
        <el-table-column label="状态" width="140">
          <template #default="{ row }">
            <el-tag size="small" :type="statusInfo(row.status).tag">{{ statusInfo(row.status).label }}</el-tag>
            <div v-if="row.status === 'failed' && row.error" class="err-text">{{ row.error }}</div>
            <el-button
              v-if="row.status === 'failed'"
              size="small"
              link
              type="primary"
              style="margin-left: 0; padding-left: 0"
              @click="retry(row)"
            >
              重试
            </el-button>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="110" fixed="right">
          <template #default="{ row }">
            <el-button size="small" link type="primary" @click="router.push(`/leads/${row.id}`)">
              查看报告
            </el-button>
          </template>
        </el-table-column>

        <template #empty>
          <el-empty description="暂无线索：去「② 找客户」自动搜索或粘贴导入" :image-size="80" />
        </template>
      </el-table>

      <div class="actions">
        <el-button type="primary" :loading="confirming" :disabled="!selected.length" @click="confirmSelected">
          确认选中客户（{{ selected.length }}）
        </el-button>
        <el-button @click="exportCsv">导出全部报告</el-button>
      </div>
    </div>
  </div>
</template>
