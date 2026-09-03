<script setup lang="ts">
/**
 * /leads/:id/email 开发信生成：
 * 「生成开发信」→ POST /api/leads/:id/email（loading 防重复点击）
 * 标题候选 radio（2 个）、正文 textarea 可编辑、词数实时自检
 * 操作：复制（纯文本）/ 导出 .eml / 重新生成 / 语种切换重新生成
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api, normalizeList, type EmailDraft, type EmailLanguage } from '../api/client'

const props = defineProps<{ id: string }>()
const router = useRouter()

const leadId = computed(() => Number(props.id) || 0)
const companyName = ref('')
const leadStatus = ref('')

/** 当前编辑中的开发信（含 id，用于 .eml 导出） */
const email = ref<EmailDraft | null>(null)
const selectedSubject = ref('')
const body = ref('')

const language = ref<EmailLanguage>('en')
/** 生成/重新生成共用 loading，防重复点击 */
const generating = ref(false)

const LANGS: { value: EmailLanguage; label: string }[] = [
  { value: 'en', label: 'English（英语）' },
  { value: 'de', label: 'Deutsch（德语）' },
  { value: 'es', label: 'Español（西班牙语）' },
  { value: 'fr', label: 'Français（法语）' },
  { value: 'zh', label: '中文' }
]

/* ---- 合规自检：词数实时统计（垃圾词由后端后置校验保证） ---- */
const wordCount = computed(() => {
  const t = body.value.trim()
  return t ? t.split(/\s+/).filter(Boolean).length : 0
})
const overLimit = computed(() => wordCount.value > 150)

/** 将生成/历史结果应用到编辑器 */
function applyEmail(e: EmailDraft): void {
  email.value = e
  body.value = e.body
  selectedSubject.value = e.subjects[0] ?? ''
}

onMounted(async () => {
  // 并行加载线索信息与历史开发信（刷新页面后可继续编辑最近一封）
  const [lead, emails] = await Promise.all([
    api.getLead(props.id).catch(() => null),
    api.listEmails(leadId.value).then((arr) => normalizeList<EmailDraft>(arr)).catch(() => [] as EmailDraft[])
  ])
  if (lead) {
    companyName.value = lead.company_name
    leadStatus.value = lead.status
  }
  if (emails.length) applyEmail(emails[emails.length - 1])
})

/* ---- 生成 / 重新生成 ---- */
async function generate(): Promise<void> {
  if (generating.value) return
  generating.value = true
  try {
    const e = await api.generateEmail(leadId.value, language.value)
    applyEmail(e)
    if (e.warnings?.length) {
      ElMessage.warning(`生成完成，但存在校验提示：${e.warnings.join('；')}`)
    } else {
      ElMessage.success('开发信已生成，可编辑后复制发送')
    }
  } finally {
    generating.value = false
  }
}

/** 切换语种：已有开发信时立即以新语种重新生成 */
function onLanguageChange(): void {
  if (email.value) void generate()
}

/* ---- 操作 ---- */

/** 复制开发信：navigator.clipboard，纯文本 */
async function copyEmail(): Promise<void> {
  if (!body.value.trim()) {
    ElMessage.warning('正文为空，请先生成开发信')
    return
  }
  try {
    await navigator.clipboard.writeText(body.value)
    ElMessage.success('已复制到剪贴板（纯文本），请粘贴到邮箱发送')
  } catch {
    ElMessage.error('复制失败，请手动选择正文复制')
  }
}

/** 导出 .eml：GET /api/emails/:id/eml */
function exportEml(): void {
  const eid = email.value?.id ?? 0
  if (!eid) {
    ElMessage.warning('请先生成开发信')
    return
  }
  window.open(`/api/emails/${eid}/eml`)
}
</script>

<template>
  <div>
    <div class="page-back">
      <el-button size="small" link type="primary" @click="router.push(`/leads/${props.id}`)">
        ← 返回客户报告
      </el-button>
    </div>

    <div class="card">
      <h2>
        个性化开发信 · {{ companyName || `线索 #${props.id}` }}
        <span class="badge">基于分析报告证据生成</span>
        <el-tag
          v-if="leadStatus === 'confirmed'"
          size="small"
          type="success"
          style="margin-left: 8px"
        >
          已确认开发
        </el-tag>
      </h2>

      <!-- 生成入口 -->
      <div v-if="!email" style="text-align: center; padding: 28px 0">
        <el-button type="primary" size="large" :loading="generating" @click="generate">
          {{ generating ? '生成中…' : '✨ 生成开发信' }}
        </el-button>
        <div class="hint" style="margin-top: 10px">
          将基于该客户的分析报告证据 + 当前产品档案生成（默认 English，可切换语种）
        </div>
      </div>

      <!-- 编辑区 -->
      <template v-else>
        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 4px">
          <label style="font-size: 13px; color: #6b7280">标题候选（选择其一）</label>
          <el-select
            v-model="language"
            size="small"
            style="width: 190px; margin-left: auto"
            @change="onLanguageChange"
          >
            <el-option v-for="l in LANGS" :key="l.value" :label="l.label" :value="l.value" />
          </el-select>
        </div>

        <!-- 标题候选 radio（2 个） -->
        <el-radio-group v-model="selectedSubject" class="subj-cands">
          <el-radio v-for="(s, i) in email.subjects" :key="i" :value="s">{{ s }}</el-radio>
        </el-radio-group>
        <div v-if="!email.subjects.length" class="missing" style="margin-bottom: 8px">
          未返回标题候选，请手动在邮箱中填写主题
        </div>

        <label style="display: block; font-size: 13px; color: #6b7280; margin: 10px 0 4px">
          正文（可编辑，150 词内）
        </label>
        <el-input
          v-model="body"
          type="textarea"
          class="email-body-textarea"
          :rows="13"
          placeholder="开发信正文…"
        />

        <!-- 合规自检提示 -->
        <div class="check-hint" :class="{ bad: overLimit, warn: wordCount > 130 && !overLimit }">
          ✓ 客户侧信息全部来自分析报告 · ✓ 我方卖点来自产品档案 ·
          <span>正文 {{ wordCount }}/150 词</span>
          <span v-if="overLimit"> · ⚠ 超过 150 词，请精简后再发送</span>
          · 无垃圾触发词（后端已校验）
        </div>
      </template>

      <div class="actions">
        <el-button type="primary" :disabled="!body.trim()" @click="copyEmail">复制开发信</el-button>
        <el-button :disabled="!email?.id" @click="exportEml">导出 .eml</el-button>
        <el-button :loading="generating" @click="generate">
          {{ email ? '重新生成' : '生成开发信' }}
        </el-button>
        <span v-if="generating" class="hint">AI 生成中，请稍候…</span>
      </div>
    </div>
  </div>
</template>
