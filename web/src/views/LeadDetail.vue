<script setup lang="ts">
/**
 * /leads/:id 客户报告详情：
 * 左侧评分卡（大号总分 + 评级 + 各维度得分/证据/进度条）
 * 右侧报告事实字段（含来源链接）+ incomplete 提示 + 确认开发/重新分析/导出报告
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api, normalizeLeadDetail, type LeadDetail, type Report } from '../api/client'

const props = defineProps<{ id: string }>()
const router = useRouter()

const lead = ref<LeadDetail | null>(null)
const loading = ref(false)
const confirming = ref(false)
const retrying = ref(false)

const leadId = computed(() => Number(props.id) || 0)
const report = computed<Report | null>(() => lead.value?.report ?? null)

const IN_PROGRESS: string[] = ['queued', 'scraping', 'analyzing']
const inProgress = computed(() => !!lead.value && IN_PROGRESS.includes(lead.value.status))

/* ---- 评级说明 ---- */
const GRADE_COMMENT: Record<string, string> = {
  A: '综合评级 A · 值得优先开发',
  B: '综合评级 B · 值得开发',
  C: '综合评级 C · 可持续观察',
  D: '综合评级 D · 优先级较低'
}
const gradeComment = computed(() => (lead.value?.grade ? GRADE_COMMENT[lead.value.grade] ?? '' : ''))

/* ---- 各维度得分（按后端评分引擎的确定性规则在前端还原展示） ---- */
interface DimScore {
  name: string
  level: string
  score: number
  max: number
  evidence: string
}

const dims = computed<DimScore[]>(() => {
  const r = report.value
  if (!r) return []
  const MATCH: Record<string, number> = { high: 40, medium: 24, low: 8 }
  const IMPORTER: Record<string, number> = { strong: 25, weak: 15, none: 0 }
  const FIT: Record<string, number> = { high: 10, medium: 6, low: 2 }
  const L3: Record<string, string> = { high: '高', medium: '中', low: '低' }
  const IMP3: Record<string, string> = { strong: '强', weak: '弱', none: '无' }

  // 规模资质：founded / employees / certifications 各 5 分
  const s = r.scale_info
  const scaleCount =
    (s?.founded ? 1 : 0) + (s?.employees ? 1 : 0) + (s?.certifications?.length ? 1 : 0)
  const scaleScore = scaleCount * 5
  // 联系可得性：有邮箱=10 / 仅表单=5 / 无=0
  const contactScore = r.contact.emails.length > 0 ? 10 : r.contact.has_form ? 5 : 0

  return [
    {
      name: '产品匹配度 40%',
      level: L3[r.match.level] ?? r.match.level,
      score: MATCH[r.match.level] ?? 0,
      max: 40,
      evidence: r.match.evidence
    },
    {
      name: '进口商证据 25%',
      level: IMP3[r.importer.level] ?? r.importer.level,
      score: IMPORTER[r.importer.level] ?? 0,
      max: 25,
      evidence: r.importer.evidence
    },
    {
      name: '规模资质 15%',
      level: scaleCount > 0 ? `${scaleCount}/3 项` : '无',
      score: scaleScore,
      max: 15,
      evidence: r.scale_evidence ?? ''
    },
    {
      name: '联系可得性 10%',
      level: contactScore === 10 ? '有邮箱' : contactScore === 5 ? '仅表单' : '无',
      score: contactScore,
      max: 10,
      evidence: ''
    },
    {
      name: '市场匹配 10%',
      level: L3[r.market_fit.level] ?? r.market_fit.level,
      score: FIT[r.market_fit.level] ?? 0,
      max: 10,
      evidence: r.market_fit.evidence
    }
  ]
})

/* ---- 数据加载（进行中时页面可见则 1.5s 轮询） ---- */
async function load(silent = false): Promise<void> {
  if (!silent) loading.value = true
  try {
    lead.value = normalizeLeadDetail(await api.getLead(props.id))
  } finally {
    if (!silent) loading.value = false
  }
}

let timer: number | undefined
function startPolling(): void {
  stopPolling()
  timer = window.setInterval(() => {
    if (document.visibilityState !== 'visible') return
    if (lead.value && !IN_PROGRESS.includes(lead.value.status)) return
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

/** 确认开发此客户 → POST /api/leads/:id/confirm → 跳转开发信页 */
async function confirmLead(): Promise<void> {
  confirming.value = true
  try {
    await api.confirm(leadId.value)
    ElMessage.success('已确认开发，进入开发信生成')
    router.push(`/leads/${leadId.value}/email`)
  } finally {
    confirming.value = false
  }
}

/** 重新分析 → POST /api/leads/:id/retry（重新入队） */
async function reanalyze(): Promise<void> {
  retrying.value = true
  try {
    await api.retry(leadId.value)
    ElMessage.success('已重新提交分析，请稍候')
    lead.value = null
    await load()
  } finally {
    retrying.value = false
  }
}

/** 导出报告：下载 report JSON */
function exportReport(): void {
  if (!report.value) {
    ElMessage.warning('暂无报告可导出')
    return
  }
  const blob = new Blob([JSON.stringify(report.value, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `report-${lead.value?.domain || leadId.value}.json`
  a.click()
  URL.revokeObjectURL(url)
  ElMessage.success('报告已导出')
}
</script>

<template>
  <div v-loading="loading">
    <div class="page-back">
      <el-button size="small" link type="primary" @click="router.push('/leads')">
        ← 返回线索列表
      </el-button>
    </div>

    <!-- 进行中 -->
    <div v-if="inProgress" class="card">
      <el-alert
        :title="`客户分析进行中（${lead?.status === 'scraping' ? '抓取官网中' : 'AI 分析中'}）…`"
        type="info"
        :closable="false"
        show-icon
      />
    </div>

    <!-- 失败 -->
    <div v-else-if="lead?.status === 'failed' || (lead && !report)" class="card">
      <el-alert
        :title="lead?.status === 'failed' ? '分析失败' : '暂无分析报告'"
        :description="lead?.error || '该线索尚未完成分析，可点击「重新分析」重新提交。'"
        type="error"
        :closable="false"
        show-icon
      />
      <div class="actions">
        <el-button type="primary" :loading="retrying" @click="reanalyze">重新分析</el-button>
        <el-button @click="router.push('/leads')">返回列表</el-button>
      </div>
    </div>

    <!-- 报告详情 -->
    <div v-else-if="report && lead" class="card report-grid">
      <!-- 左：评分卡 -->
      <div>
        <div class="scorecard">
          <div class="big">{{ lead.score ?? '—' }}</div>
          <div class="comment">{{ gradeComment || `综合评级 ${lead.grade ?? '—'}` }}</div>
        </div>
        <div style="margin-top: 14px">
          <div v-for="d in dims" :key="d.name" class="dim">
            <div class="head">
              <span class="name">{{ d.name }}</span>
              <span class="val">
                <b>{{ d.level }}（{{ d.score }}/{{ d.max }}）</b>
              </span>
            </div>
            <div class="bar">
              <i :style="{ width: `${Math.min(100, Math.round((d.score / d.max) * 100))}%` }" />
            </div>
            <div v-if="d.evidence" class="ev">{{ d.evidence }}</div>
          </div>
        </div>
      </div>

      <!-- 右：报告事实 -->
      <div>
        <h2>{{ lead.company_name }} · 客户分析报告 <span class="badge">所有事实均来自官网抓取</span></h2>
        <div class="facts">
          <div class="fact">
            <b>公司概况：</b>{{ report.company_summary }}
            <span v-if="report.company_summary_evidence" class="src">[{{ report.company_summary_evidence }}]</span>
          </div>
          <div class="fact">
            <b>主营业务：</b>{{ report.main_business }}
          </div>
          <div class="fact">
            <b>产品线：</b>{{ report.product_lines?.length ? report.product_lines.join('、') : '—' }}
          </div>
          <div class="fact">
            <b>市场覆盖：</b>{{ report.market_coverage || '—' }}
          </div>
          <div class="fact">
            <b>规模与资质：</b>
            <template v-if="report.scale_info">
              <template v-if="report.scale_info.founded">成立于 {{ report.scale_info.founded }}；</template>
              <template v-if="report.scale_info.employees">员工 {{ report.scale_info.employees }}；</template>
              <template v-if="report.scale_info.certifications?.length">
                认证：{{ report.scale_info.certifications.join('、') }}
              </template>
            </template>
            <span v-else class="missing">未获取到规模信息</span>
            <span v-if="report.scale_evidence" class="src">[{{ report.scale_evidence }}]</span>
          </div>
          <div class="fact">
            <b>与我方匹配评估：</b>{{ report.match.evidence }}
          </div>
          <div class="fact">
            <b>进口商/采购证据：</b>
            <el-tag
              size="small"
              :type="report.importer.level === 'strong' ? 'success' : report.importer.level === 'weak' ? 'warning' : 'danger'"
            >
              {{ report.importer.level === 'strong' ? '强' : report.importer.level === 'weak' ? '弱' : '无' }}
            </el-tag>
            {{ report.importer.evidence }}
          </div>
          <div class="fact">
            <b>目标市场匹配：</b>{{ report.market_fit.evidence }}
          </div>
          <div class="fact">
            <b>联系方式：</b>
            <template v-if="report.contact.emails.length">
              {{ report.contact.emails.join(' / ') }}
              <template v-if="report.contact.persons.length">
                · 联系人：{{ report.contact.persons.join('、') }}
              </template>
            </template>
            <template v-else-if="report.contact.has_form">仅网站表单</template>
            <span v-else class="missing">未发现联系方式</span>
          </div>
        </div>

        <!-- incomplete 黄色提示 -->
        <el-alert
          v-if="report.incomplete?.length"
          type="warning"
          :closable="false"
          show-icon
          style="margin-top: 12px"
        >
          <template #title>以下信息未能从官网获取，请注意甄别：</template>
          <div v-for="(m, i) in report.incomplete" :key="i" class="missing">· {{ m }}</div>
        </el-alert>

        <!-- sources 来源链接 -->
        <div v-if="report.sources?.length" style="margin-top: 12px">
          <b style="font-size: 13px">来源：</b>
          <ul class="sources">
            <li v-for="(s, i) in report.sources" :key="i">
              <a :href="s.url" target="_blank" rel="noopener noreferrer">{{ s.page || s.url }}</a>
              <span class="src"> · 抓取 {{ s.fetched_at }}</span>
            </li>
          </ul>
        </div>

        <div class="actions">
          <el-button type="primary" :loading="confirming" @click="confirmLead">
            ✓ 确认开发此客户
          </el-button>
          <el-button :loading="retrying" @click="reanalyze">重新分析</el-button>
          <el-button @click="exportReport">导出报告</el-button>
        </div>
      </div>
    </div>
  </div>
</template>
