<script setup lang="ts">
/**
 * /prospecting 找客户：
 * 上半部：自动搜索表单（关键词/市场/搜索引擎）→ POST /api/search → 候选表格 → 分析选中
 * 下半部：粘贴导入（弱化虚线卡片）→ POST /api/leads/import
 */
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api, normalizeList, type Lead, type SearchProvider } from '../api/client'
import { useProfileStore } from '../stores/profile'

const store = useProfileStore()
const router = useRouter()

/* ---- 自动搜索 ---- */
const form = reactive<{ keywords: string; markets: string; provider: SearchProvider }>({
  keywords: '',
  markets: '',
  provider: 'duckduckgo'
})
const searching = ref(false)
const analyzing = ref(false)
const candidates = ref<Lead[]>([])
const selected = ref<number[]>([])

const providerOptions: { value: SearchProvider; label: string }[] = [
  { value: 'duckduckgo', label: 'DuckDuckGo（默认 · 免 key）' },
  { value: 'google_cse', label: 'Google CSE（需配置 key）' },
  { value: 'serpapi', label: 'SerpAPI（需配置 key）' }
]

onMounted(async () => {
  await store.fetch()
  const p = store.current
  // 预填当前档案的关键词与市场（不覆盖用户已输入内容）
  if (p && !form.keywords) form.keywords = p.keywords
  if (p && !form.markets) form.markets = p.markets
})

/** 开始自动搜索 → POST /api/search */
async function doSearch(): Promise<void> {
  if (!store.current) {
    ElMessage.warning('请先在「① 产品档案」创建档案')
    return
  }
  searching.value = true
  candidates.value = []
  selected.value = []
  try {
    candidates.value = normalizeList<Lead>(
      await api.search({
        profileId: store.current.id,
        keywords: form.keywords,
        markets: form.markets,
        provider: form.provider
      })
    )
    // 默认全选候选
    selected.value = candidates.value.map((c) => c.id)
    ElMessage.success(`搜索完成：发现 ${candidates.value.length} 条候选线索（已去重、过滤电商站）`)
  } finally {
    searching.value = false
  }
}

function onSelectionChange(rows: unknown[]): void {
  selected.value = (rows as Lead[]).map((r) => r.id)
}

/** 分析选中线索 → POST /api/leads/analyze */
async function analyzeSelected(): Promise<void> {
  if (!selected.value.length) {
    ElMessage.warning('请先勾选要分析的候选线索')
    return
  }
  analyzing.value = true
  try {
    await api.analyze(selected.value)
    ElMessage.success(`已提交 ${selected.value.length} 条线索，开始抓取分析…`)
    router.push('/leads')
  } finally {
    analyzing.value = false
  }
}

/* ---- 粘贴导入 ---- */
const importText = ref('')
const importing = ref(false)

/** 粘贴导入（每行一条公司名或 URL）→ POST /api/leads/import，成功后直接提交分析 */
async function doImport(): Promise<void> {
  const items = importText.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!items.length) {
    ElMessage.warning('请粘贴公司名或网址，每行一条')
    return
  }
  if (!store.current) {
    ElMessage.warning('请先在「① 产品档案」创建档案')
    return
  }
  importing.value = true
  try {
    const res = await api.importLeads(store.current.id, items)
    // 兼容返回 Lead[] / number[] / { leads: [...] } 等结构，取出 id 提交分析
    const arr = normalizeList<Lead | number>(res)
    const ids = arr
      .map((x) => (typeof x === 'object' && x !== null ? Number((x as Lead).id) : Number(x)))
      .filter((n) => Number.isFinite(n) && n > 0)
    if (ids.length) {
      await api.analyze(ids)
      ElMessage.success(`已导入并提交 ${ids.length} 条线索分析`)
    } else {
      ElMessage.success('导入成功，请到线索列表提交分析')
    }
    importText.value = ''
    router.push('/leads')
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <div>
    <!-- 自动搜索（主通道） -->
    <div class="card">
      <h2>
        自动搜索潜在客户
        <span class="badge">主通道 · 基于产品档案</span>
      </h2>

      <el-form label-width="120px" label-position="left">
        <el-form-item label="搜索关键词">
          <el-input v-model="form.keywords" placeholder="来自产品档案，可临时修改" />
        </el-form-item>
        <el-form-item label="目标市场">
          <el-input v-model="form.markets" placeholder="来自产品档案，可临时修改" />
        </el-form-item>
        <el-form-item label="搜索引擎">
          <el-select v-model="form.provider" style="width: 280px">
            <el-option v-for="o in providerOptions" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
      </el-form>

      <div class="hint">
        将自动组合查询："{{ form.keywords }}" wholesale/importer/distributor + 目标市场，过滤电商平台与目录站后生成候选公司。
      </div>

      <div class="actions">
        <el-button type="primary" :loading="searching" @click="doSearch">🔍 开始自动搜索</el-button>
      </div>

      <!-- 候选结果表格 -->
      <el-table
        v-if="candidates.length"
        :data="candidates"
        row-key="id"
        style="margin-top: 14px"
        @selection-change="onSelectionChange"
      >
        <el-table-column type="selection" width="42" />
        <el-table-column label="公司" min-width="220">
          <template #default="{ row }">
            <div class="cell-main">
              <b>{{ row.company_name }}</b>
              <span class="src">{{ row.domain }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="来源 query" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="src">{{ row.source_query || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default>
            <el-tag size="small" type="info">新发现</el-tag>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-else description="尚无搜索结果，点击「开始自动搜索」发现潜在客户" :image-size="72" />

      <div class="actions">
        <el-button
          type="primary"
          :loading="analyzing"
          :disabled="!selected.length"
          @click="analyzeSelected"
        >
          ✓ 分析选中线索（{{ selected.length }}）
        </el-button>
      </div>
    </div>

    <!-- 粘贴导入（备用，弱化） -->
    <div class="card dashed">
      <h2 class="sub">备用：粘贴导入（已找到的公司名/URL，每行一个）</h2>
      <el-input
        v-model="importText"
        type="textarea"
        :rows="4"
        placeholder="https://www.example.com&#10;Alpine Drinkware GmbH"
      />
      <div class="actions">
        <el-button :loading="importing" @click="doImport">提交批量分析</el-button>
        <span class="hint">导入后自动去重并直接提交抓取分析</span>
      </div>
    </div>
  </div>
</template>
