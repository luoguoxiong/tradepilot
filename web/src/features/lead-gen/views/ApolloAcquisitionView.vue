<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'

import {
  fetchApolloRun,
  fetchApolloRuns,
  fetchSeedProfile,
  generateApolloKeywords,
  runApolloAnalyze,
  runApolloSearch,
} from '@/api/resources/apollo'
import { getCustomers } from '@/api/resources/customers'
import type {
  ApolloAnalyzeResult,
  ApolloOrgResult,
  ApolloRunListItem,
  ApolloSearchParams,
  ApolloSeedProfile,
} from '@/api/types/apollo'
import type { CustomerItem } from '@/api/types/customers'
import { handleApiError } from '@/api/error-handler'

/**
 * Apollo 相似客户获客（四步向导）：
 * ① 选种子客户（CRM，如 EASYFEET）→ 展示种子画像；
 * ② AI 拆解画像 → Apollo 搜索参数（可编辑）；
 * ③ 调用 Apollo 检索公司 + 联系人；
 * ④ AI 对照种子画像二次复筛 → 符合条件的写入客户发现池（复用既有转 CRM / 开发信链路）。
 */
const { t } = useI18n()
const router = useRouter()

const step = ref(0)
const submitting = ref(false)

// ===== 步骤① 种子客户（CRM 选择 / 手动输入公司名 二选一）=====
type SeedMode = 'crm' | 'manual'
const seedMode = ref<SeedMode>('crm')
const seedOptions = ref<CustomerItem[]>([])
const seedLoading = ref(false)
const seedId = ref('')
const manual = reactive({
  companyName: '',
  country: '',
  website: '',
  industry: '',
})
const seedProfile = ref<ApolloSeedProfile | null>(null)

async function searchSeed(keyword: string) {
  seedLoading.value = true
  try {
    const page = await getCustomers({ page: 1, pageSize: 20, keyword: keyword || undefined })
    seedOptions.value = page.items
  } catch (error) {
    handleApiError(error)
  } finally {
    seedLoading.value = false
  }
}

async function onSeedChange(customerId: string) {
  seedProfile.value = null
  if (!customerId) return
  try {
    seedProfile.value = await fetchSeedProfile(customerId)
  } catch (error) {
    handleApiError(error)
  }
}

/** 手动输入公司名 → 本地合成种子画像（不发请求，预览用） */
function buildManualProfile(): ApolloSeedProfile {
  return {
    customerId: '',
    companyName: manual.companyName.trim(),
    country: manual.country.trim() || 'Unknown',
    website: manual.website.trim() || null,
    industry: manual.industry.trim() || null,
    industryTags: [],
    customerType: null,
    stage: 'manual_seed',
    score: null,
    remark: null,
    contacts: [],
    insights: [],
  }
}

function onSeedModeChange(mode: SeedMode) {
  seedProfile.value = null
  if (mode === 'manual' && manual.companyName.trim()) {
    seedProfile.value = buildManualProfile()
  }
}

function onManualInput() {
  if (seedMode.value === 'manual' && manual.companyName.trim()) {
    seedProfile.value = buildManualProfile()
  }
}

// ===== 步骤② AI 拆解 → 搜索参数 =====
const extraGoal = ref('')
const runId = ref('')
const params = reactive<Partial<ApolloSearchParams>>({
  keywordTags: [],
  locations: [],
  employeeRanges: [],
  contactTitles: [],
  rationale: '',
})

function fillParams(source: ApolloSearchParams) {
  params.keywordTags = [...source.keywordTags]
  params.locations = [...source.locations]
  params.employeeRanges = source.employeeRanges.map((r) => [...r] as [number, number])
  params.contactTitles = [...source.contactTitles]
  params.rationale = source.rationale
}

async function onGenerateKeywords() {
  const seedPayload =
    seedMode.value === 'crm'
      ? seedId.value
        ? { customerId: seedId.value }
        : null
      : manual.companyName.trim()
        ? {
            companyName: manual.companyName.trim(),
            ...(manual.country.trim() ? { country: manual.country.trim() } : {}),
            ...(manual.website.trim() ? { website: manual.website.trim() } : {}),
            ...(manual.industry.trim() ? { industry: manual.industry.trim() } : {}),
          }
        : null
  if (!seedPayload) {
    ElMessage.warning(t('apolloAcq.seedRequired'))
    return
  }
  submitting.value = true
  try {
    const resp = await generateApolloKeywords({
      ...seedPayload,
      ...(extraGoal.value.trim() ? { extraGoal: extraGoal.value.trim() } : {}),
    })
    runId.value = resp.runId
    fillParams(resp.searchParams)
    step.value = 1
    void loadRuns()
  } catch (error) {
    handleApiError(error)
  } finally {
    submitting.value = false
  }
}

// ===== 步骤③ Apollo 检索 =====
const results = ref<ApolloOrgResult[]>([])
const totalCompanies = ref(0)

async function onSearch() {
  submitting.value = true
  try {
    const resp = await runApolloSearch(runId.value, {
      searchParams: {
        keywordTags: params.keywordTags ?? [],
        locations: params.locations ?? [],
        employeeRanges: params.employeeRanges ?? [],
        contactTitles: params.contactTitles ?? [],
      },
    })
    results.value = resp.results
    totalCompanies.value = resp.totalCompanies
    step.value = 2
    ElMessage.success(t('apolloAcq.totalCompanies', { count: resp.totalCompanies }))
    void loadRuns()
  } catch (error) {
    handleApiError(error)
  } finally {
    submitting.value = false
  }
}

// ===== 步骤④ AI 复筛 =====
const threshold = ref(60)
const analyzeResults = ref<ApolloAnalyzeResult[]>([])
const qualifiedCount = ref(0)
const savedLeadCount = ref(0)

async function onAnalyze() {
  submitting.value = true
  ElMessage.info(t('apolloAcq.analyzing'))
  try {
    const resp = await runApolloAnalyze(runId.value, { threshold: threshold.value })
    analyzeResults.value = resp.analyzeResults
    qualifiedCount.value = resp.qualifiedCount
    savedLeadCount.value = resp.savedLeadCount
    step.value = 3
    ElMessage.success(t('apolloAcq.savedLeadCount', { count: resp.savedLeadCount }))
    void loadRuns()
  } catch (error) {
    handleApiError(error)
  } finally {
    submitting.value = false
  }
}

function goDiscover() {
  void router.push({ name: 'lead-discover' })
}

// ===== 历史轮次 =====
const runs = ref<ApolloRunListItem[]>([])

async function loadRuns() {
  try {
    const resp = await fetchApolloRuns()
    runs.value = resp.runs
  } catch (error) {
    handleApiError(error)
  }
}
void loadRuns()

async function onLoadRun(run: ApolloRunListItem) {
  try {
    const detail = await fetchApolloRun(run.id)
    runId.value = detail.id
    seedMode.value = detail.seedCustomerId ? 'crm' : 'manual'
    seedId.value = detail.seedCustomerId ?? ''
    if (!detail.seedCustomerId) {
      manual.companyName = detail.seedProfile.companyName
      manual.country = detail.seedProfile.country === 'Unknown' ? '' : detail.seedProfile.country
      manual.website = detail.seedProfile.website ?? ''
      manual.industry = detail.seedProfile.industry ?? ''
    }
    seedProfile.value = detail.seedProfile
    analyzeResults.value = detail.analyzeResults ?? []
    qualifiedCount.value = detail.qualifiedCount
    savedLeadCount.value = detail.savedLeadCount
    totalCompanies.value = detail.totalCompanies
    results.value = detail.results ?? []
    if (detail.searchParams) fillParams(detail.searchParams)
    step.value = detail.status === 'analyzed' ? 3 : detail.status === 'searched' ? 2 : 1
  } catch (error) {
    handleApiError(error)
  }
}

const statusTagType = computed(() => {
  return (status: ApolloRunListItem['status']) =>
    status === 'analyzed' ? 'success' : status === 'failed' ? 'danger' : 'info'
})
</script>

<template>
  <div class="apollo-acq">
    <header class="apollo-acq__header">
      <h2 class="apollo-acq__title">{{ t('apolloAcq.title') }}</h2>
      <p class="apollo-acq__subtitle">{{ t('apolloAcq.subtitle') }}</p>
    </header>

    <el-steps :active="step" align-center finish-status="success" class="apollo-acq__steps">
      <el-step :title="t('apolloAcq.seedStep')" />
      <el-step :title="t('apolloAcq.keywordsStep')" />
      <el-step :title="t('apolloAcq.searchStep')" />
      <el-step :title="t('apolloAcq.analyzeStep')" />
    </el-steps>

    <el-alert
      class="apollo-acq__alert"
      :title="t('apolloAcq.needApolloProvider')"
      type="warning"
      :closable="false"
      show-icon
    />

    <!-- 步骤①：种子客户（CRM 选择 / 手动输入） -->
    <el-card class="apollo-acq__card" shadow="never">
      <template #header>{{ t('apolloAcq.seedStep') }}</template>
      <el-radio-group v-model="seedMode" class="apollo-acq__mode" @change="onSeedModeChange">
        <el-radio-button value="crm">{{ t('apolloAcq.seedModeCrm') }}</el-radio-button>
        <el-radio-button value="manual">{{ t('apolloAcq.seedModeManual') }}</el-radio-button>
      </el-radio-group>

      <el-select
        v-if="seedMode === 'crm'"
        v-model="seedId"
        filterable
        remote
        clearable
        :remote-method="searchSeed"
        :loading="seedLoading"
        :placeholder="t('apolloAcq.seedPlaceholder')"
        class="apollo-acq__seed-select"
        @change="onSeedChange"
        @focus="searchSeed('')"
      >
        <el-option
          v-for="item in seedOptions"
          :key="item.customerId"
          :value="item.customerId"
          :label="`${item.companyName}（${item.country}）`"
        />
      </el-select>

      <div v-else class="apollo-acq__manual">
        <el-input
          v-model="manual.companyName"
          :placeholder="t('apolloAcq.manualCompanyPlaceholder')"
          class="apollo-acq__manual-name"
          @input="onManualInput"
        />
        <el-input
          v-model="manual.country"
          :placeholder="t('apolloAcq.manualCountryPlaceholder')"
          class="apollo-acq__manual-field"
          @input="onManualInput"
        />
        <el-input
          v-model="manual.website"
          :placeholder="t('apolloAcq.manualWebsitePlaceholder')"
          class="apollo-acq__manual-field"
          @input="onManualInput"
        />
        <el-input
          v-model="manual.industry"
          :placeholder="t('apolloAcq.manualIndustryPlaceholder')"
          class="apollo-acq__manual-field"
          @input="onManualInput"
        />
      </div>

      <div v-if="seedProfile" class="apollo-acq__profile">
        <h4>{{ t('apolloAcq.seedProfile') }}</h4>
        <el-descriptions :column="2" size="small" border>
          <el-descriptions-item label="Company">{{ seedProfile.companyName }}</el-descriptions-item>
          <el-descriptions-item label="Country">{{ seedProfile.country }}</el-descriptions-item>
          <el-descriptions-item label="Industry">{{
            seedProfile.industry ?? '—'
          }}</el-descriptions-item>
          <el-descriptions-item :label="t('apolloAcq.industryTags')">
            <el-tag
              v-for="tag in seedProfile.industryTags"
              :key="tag"
              size="small"
              class="apollo-acq__tag"
            >
              {{ tag }}
            </el-tag>
          </el-descriptions-item>
        </el-descriptions>
        <p class="apollo-acq__contacts">
          {{ t('apolloAcq.contactsCount', { count: seedProfile.contacts.length }) }}
        </p>
      </div>

      <el-input
        v-model="extraGoal"
        type="textarea"
        :rows="2"
        maxlength="500"
        :placeholder="t('apolloAcq.extraGoalPlaceholder')"
        class="apollo-acq__extra"
      />
      <div class="apollo-acq__actions">
        <el-button
          type="primary"
          :loading="submitting"
          :disabled="!seedProfile"
          @click="onGenerateKeywords"
        >
          {{ t('apolloAcq.generateKeywords') }}
        </el-button>
      </div>
    </el-card>

    <!-- 步骤②：搜索参数（可编辑） -->
    <el-card v-if="step >= 1" class="apollo-acq__card" shadow="never">
      <template #header>{{ t('apolloAcq.keywordsStep') }}</template>
      <el-form label-width="180px" label-position="left">
        <el-form-item :label="t('apolloAcq.keywordTags')">
          <el-select
            v-model="params.keywordTags"
            multiple
            filterable
            allow-create
            default-first-option
            class="apollo-acq__field"
          />
        </el-form-item>
        <el-form-item :label="t('apolloAcq.locations')">
          <el-select
            v-model="params.locations"
            multiple
            filterable
            allow-create
            default-first-option
            class="apollo-acq__field"
          />
        </el-form-item>
        <el-form-item :label="t('apolloAcq.employeeRanges')">
          <div v-for="(range, idx) in params.employeeRanges" :key="idx" class="apollo-acq__range">
            <el-input-number v-model="range[0]" :min="0" :step="10" controls-position="right" />
            <span>—</span>
            <el-input-number v-model="range[1]" :min="0" :step="10" controls-position="right" />
            <el-button link type="danger" @click="params.employeeRanges?.splice(idx, 1)"
              >✕</el-button
            >
          </div>
          <el-button
            link
            type="primary"
            @click="params.employeeRanges?.push([50, 500] as [number, number])"
          >
            + {{ t('apolloAcq.employeeRanges') }}
          </el-button>
        </el-form-item>
        <el-form-item :label="t('apolloAcq.contactTitles')">
          <el-select
            v-model="params.contactTitles"
            multiple
            filterable
            allow-create
            default-first-option
            class="apollo-acq__field"
          />
        </el-form-item>
        <el-form-item v-if="params.rationale" :label="t('apolloAcq.rationale')">
          <span class="apollo-acq__rationale">{{ params.rationale }}</span>
        </el-form-item>
      </el-form>
      <div class="apollo-acq__actions">
        <el-button type="primary" :loading="submitting" @click="onSearch">
          {{ t('apolloAcq.startSearch') }}
        </el-button>
      </div>
    </el-card>

    <!-- 步骤③：Apollo 检索结果 -->
    <el-card v-if="step >= 2" class="apollo-acq__card" shadow="never">
      <template #header>
        <div class="apollo-acq__card-header">
          <span>{{ t('apolloAcq.searchStep') }}</span>
          <el-button link type="primary" :loading="submitting" @click="onSearch">
            {{ t('apolloAcq.reSearch') }}
          </el-button>
        </div>
      </template>
      <el-table :data="results" stripe size="small" max-height="420">
        <el-table-column prop="companyName" label="Company" min-width="180" />
        <el-table-column prop="country" label="Country" width="110" />
        <el-table-column prop="industry" label="Industry" min-width="140" />
        <el-table-column label="Employees" width="100">
          <template #default="{ row }">{{ row.employeeCount ?? '—' }}</template>
        </el-table-column>
        <el-table-column :label="t('apolloAcq.contactTitles')" min-width="220">
          <template #default="{ row }">
            <div
              v-for="c in row.contacts.slice(0, 3)"
              :key="c.apolloPersonId"
              class="apollo-acq__contact"
            >
              <span>{{ c.name }}</span>
              <span class="apollo-acq__contact-title">{{ c.title ?? '' }}</span>
              <el-tooltip v-if="!c.email && c.emailStatus" :content="t('apolloAcq.emailLocked')">
                <el-tag size="small" type="info">🔒</el-tag>
              </el-tooltip>
              <span v-else-if="c.email" class="apollo-acq__email">{{ c.email }}</span>
            </div>
            <span v-if="row.contacts.length === 0">—</span>
          </template>
        </el-table-column>
        <template #empty>
          <span>—</span>
        </template>
      </el-table>
    </el-card>

    <!-- 步骤④：AI 复筛 -->
    <el-card v-if="step >= 2" class="apollo-acq__card" shadow="never">
      <template #header>{{ t('apolloAcq.analyzeStep') }}</template>
      <div class="apollo-acq__analyze-bar">
        <span>{{ t('apolloAcq.threshold') }}</span>
        <el-slider v-model="threshold" :min="0" :max="100" :step="5" class="apollo-acq__slider" />
        <span class="apollo-acq__threshold-value">{{ threshold }}</span>
        <el-button type="primary" :loading="submitting" @click="onAnalyze">
          {{ t('apolloAcq.startAnalyze') }}
        </el-button>
      </div>

      <el-alert
        v-if="step === 3 && savedLeadCount > 0"
        :title="`${t('apolloAcq.inDiscoverPool')}（${t('apolloAcq.qualifiedCount', { count: qualifiedCount })} / ${t('apolloAcq.savedLeadCount', { count: savedLeadCount })}）`"
        type="success"
        :closable="false"
        show-icon
        class="apollo-acq__alert"
      >
        <el-button link type="primary" @click="goDiscover">{{
          t('apolloAcq.goDiscover')
        }}</el-button>
      </el-alert>

      <el-table
        v-if="analyzeResults.length > 0"
        :data="analyzeResults"
        stripe
        size="small"
        max-height="380"
      >
        <el-table-column prop="companyName" label="Company" min-width="160" />
        <el-table-column :label="t('apolloAcq.matchPct')" width="90">
          <template #default="{ row }">
            <el-tag
              :type="
                row.scoreLevel === 'high'
                  ? 'success'
                  : row.scoreLevel === 'medium'
                    ? 'warning'
                    : 'info'
              "
              size="small"
            >
              {{ row.matchPct }}%
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column :label="t('apolloAcq.qualified')" width="100">
          <template #default="{ row }">
            <el-tag :type="row.qualified ? 'success' : 'danger'" size="small" effect="plain">
              {{ row.qualified ? t('apolloAcq.qualified') : t('apolloAcq.rejected') }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="Reasons" min-width="260">
          <template #default="{ row }">
            <div v-for="(r, i) in row.reasons" :key="i" class="apollo-acq__reason">
              · {{ r.text }}
            </div>
            <div v-if="row.rejectReason" class="apollo-acq__reject">
              {{ t('apolloAcq.rejectReason') }}: {{ row.rejectReason }}
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 历史轮次 -->
    <el-card class="apollo-acq__card" shadow="never">
      <template #header>{{ t('apolloAcq.runHistory') }}</template>
      <el-table v-if="runs.length > 0" :data="runs" stripe size="small">
        <el-table-column prop="id" label="Run" min-width="180" show-overflow-tooltip />
        <el-table-column label="Status" width="110">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small">
              {{ t(`apolloAcq.status${row.status.charAt(0).toUpperCase()}${row.status.slice(1)}`) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="totalCompanies" label="Companies" width="110" />
        <el-table-column prop="savedLeadCount" label="Saved" width="90" />
        <el-table-column prop="createdAt" label="Created" min-width="160" />
        <el-table-column label="" width="100">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="onLoadRun(row)">查看</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <span>{{ t('apolloAcq.noRuns') }}</span>
        </template>
      </el-table>
      <p v-else class="apollo-acq__empty">{{ t('apolloAcq.noRuns') }}</p>
    </el-card>
  </div>
</template>

<style scoped lang="scss">
.apollo-acq {
  display: flex;
  flex-direction: column;
  gap: calc(var(--tp-spacing-base) * 3);

  &__header {
    text-align: center;
  }

  &__title {
    margin: 0;
    font-size: 20px;
  }

  &__subtitle {
    margin: 8px 0 0;
    color: var(--tp-text-secondary);
    font-size: 13px;
  }

  &__steps {
    padding: 8px 0;
  }

  &__alert {
    margin-bottom: calc(var(--tp-spacing-base) * 2);
  }

  &__card {
    border-radius: 8px;
  }

  &__card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  &__mode {
    margin-bottom: 12px;
  }

  &__seed-select {
    width: 420px;
    max-width: 100%;
  }

  &__manual {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;

    .apollo-acq__manual-name {
      flex: 1 1 260px;
    }

    .apollo-acq__manual-field {
      flex: 1 1 160px;
    }
  }

  &__profile {
    margin-top: 16px;

    h4 {
      margin: 0 0 8px;
      font-size: 13px;
      color: var(--tp-text-secondary);
    }
  }

  &__tag {
    margin-right: 4px;
  }

  &__contacts {
    margin: 8px 0 0;
    color: var(--tp-text-secondary);
    font-size: 12px;
  }

  &__extra {
    margin-top: 12px;
  }

  &__actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 12px;
  }

  &__field {
    width: 100%;
  }

  &__range {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  &__rationale {
    color: var(--tp-text-secondary);
    font-size: 12px;
    line-height: 1.6;
  }

  &__contact {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }

  &__contact-title {
    color: var(--tp-text-secondary);
  }

  &__email {
    color: var(--tp-text-secondary);
    font-family: monospace;
  }

  &__analyze-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }

  &__slider {
    flex: 1;
    max-width: 320px;
  }

  &__threshold-value {
    min-width: 32px;
    text-align: center;
    font-weight: 600;
  }

  &__reason {
    font-size: 12px;
    line-height: 1.6;
  }

  &__reject {
    margin-top: 4px;
    color: var(--el-color-danger);
    font-size: 12px;
  }

  &__empty {
    margin: 0;
    color: var(--tp-text-secondary);
    font-size: 13px;
    text-align: center;
    padding: 16px 0;
  }
}
</style>
