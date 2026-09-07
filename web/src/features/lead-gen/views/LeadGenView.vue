<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'

import AiStatusTag from '@/components/business/AiStatusTag.vue'
import TaskWorkspace from '@/features/lead-gen/components/TaskWorkspace.vue'
import { createLeadTask, getLeadHunterSummary, parseLeadGoal } from '@/api/resources/leads'
import type { LeadParseResp } from '@/api/types/leads'
import { staleTime, isTerminalStatus } from '@/query/options'
import { qk } from '@/query/keys'

/**
 * 03-AI获客工作台（04 §3.3）：
 * 头部 = GET /lead-hunter/summary（员工状态/今日产出/当前任务）；
 * 创建任务 = 自然语言 goalText + AI 解析回填结构化字段（parse 只产出 4 基础字段，可改）
 *   + 高级设置阈值 → POST /lead-tasks；
 * 任务执行中 = TaskWorkspace 常驻（SSE 日志流，断线自动降级轮询），done 后刷新发现列表。
 */
const { t } = useI18n()
const router = useRouter()
const queryClient = useQueryClient()

// ===== 工作台头部 =====
const summaryQuery = useQuery({
  queryKey: qk.leadHunterSummary,
  queryFn: getLeadHunterSummary,
  staleTime: staleTime.DETAIL,
})

const currentTaskId = computed(() => summaryQuery.data.value?.currentTask?.taskId ?? null)
const currentTaskFinished = computed(() => {
  const status = summaryQuery.data.value?.currentTask?.status
  return status ? isTerminalStatus(status) : false
})

// ===== 创建任务 =====
const parsing = ref(false)
const submitting = ref(false)
const parsed = ref<LeadParseResp | null>(null)
const goalText = ref('')

const form = reactive({
  targetMarket: '',
  customerType: '',
  targetProduct: '',
  companySize: '',
  targetCount: 35,
  thresholdHigh: 85,
  thresholdMedium: 60,
})

async function onParse() {
  if (!goalText.value.trim()) {
    ElMessage.warning(t('leadGen.goalPlaceholder'))
    return
  }
  parsing.value = true
  try {
    const resp = await parseLeadGoal(goalText.value.trim())
    parsed.value = resp
    form.targetMarket = resp.parsed.targetMarket
    form.customerType = resp.parsed.customerType
    form.targetProduct = resp.parsed.targetProduct
    form.companySize = resp.parsed.companySize ?? ''
  } finally {
    parsing.value = false
  }
}

async function onCreate() {
  if (!goalText.value.trim() || !form.targetMarket || !form.targetProduct) {
    ElMessage.warning(t('leadGen.goalPlaceholder'))
    return
  }
  submitting.value = true
  try {
    const resp = await createLeadTask({
      goalText: goalText.value.trim(),
      parsed: {
        targetMarket: form.targetMarket,
        customerType: form.customerType,
        targetProduct: form.targetProduct,
        ...(form.companySize ? { companySize: form.companySize } : {}),
      },
      advancedSettings: {
        matchThresholds: { high: form.thresholdHigh, medium: form.thresholdMedium },
      },
      targetCount: form.targetCount,
    })
    ElMessage.success(t('leadGen.createTaskTip'))
    // 立即以新任务进入工作台（不等 summary 轮询）
    await queryClient.invalidateQueries({ queryKey: qk.leadHunterSummary })
    activeTaskId.value = resp.taskId
  } finally {
    submitting.value = false
  }
}

// 工作台任务：优先展示用户刚创建/正在查看的任务；无则回落 summary.currentTask
const activeTaskId = ref<string | null>(null)
const workspaceTaskId = computed(() => activeTaskId.value ?? currentTaskId.value)

function goDiscover() {
  void router.push({ name: 'lead-discover' })
}
</script>

<template>
  <div class="lead-gen">
    <!-- 头部：获客员工概览（03 §1.1） -->
    <el-card shadow="never" class="lead-gen__header" v-loading="summaryQuery.isLoading.value">
      <template v-if="summaryQuery.data.value">
        <div class="lead-gen__hunter">
          <div class="lead-gen__hunter-info">
            <span class="lead-gen__hunter-name">
              🤖 {{ summaryQuery.data.value.employee.name }}
            </span>
            <AiStatusTag
              group="employeeStatus"
              :value="summaryQuery.data.value.employee.status"
              :detail="summaryQuery.data.value.employee.statusDetail"
            />
          </div>
          <div class="lead-gen__today">
            <div class="lead-gen__today-item">
              <span class="lead-gen__today-num">{{
                summaryQuery.data.value.todaySummary.found
              }}</span>
              <span class="lead-gen__today-label">{{ t('leadGen.todayFound') }}</span>
            </div>
            <div class="lead-gen__today-item">
              <span class="lead-gen__today-num">{{
                summaryQuery.data.value.todaySummary.analyzed
              }}</span>
              <span class="lead-gen__today-label">{{ t('leadGen.todayAnalyzed') }}</span>
            </div>
            <div class="lead-gen__today-item">
              <span class="lead-gen__today-num is-high">{{
                summaryQuery.data.value.todaySummary.highValue
              }}</span>
              <span class="lead-gen__today-label">{{ t('leadGen.todayHighValue') }}</span>
            </div>
          </div>
        </div>
        <el-divider style="margin: 12px 0" />
        <div class="lead-gen__current">
          <template v-if="summaryQuery.data.value.currentTask && !currentTaskFinished">
            <span class="lead-gen__current-label">{{ t('leadGen.currentTask') }}</span>
            <span class="lead-gen__current-goal">{{
              summaryQuery.data.value.currentTask.goal
            }}</span>
            <el-progress
              class="lead-gen__current-progress"
              :percentage="summaryQuery.data.value.currentTask.progressPct"
              :stroke-width="8"
            />
          </template>
          <template v-else>
            <span class="lead-gen__current-empty">{{ t('leadGen.noRunningTask') }}</span>
          </template>
          <el-button link type="primary" @click="goDiscover">
            {{ t('leadGen.viewLeads') }} →
          </el-button>
        </div>
      </template>
    </el-card>

    <!-- 任务工作台（执行中/已完成任务实时日志流） -->
    <el-card v-if="workspaceTaskId" shadow="never" class="lead-gen__workspace">
      <template #header>
        <div class="lead-gen__card-header">
          <span>{{ t('leadGen.taskWorkspace') }}</span>
          <el-button v-if="currentTaskFinished" size="small" type="primary" @click="goDiscover">
            {{ t('leadGen.viewLeads') }}
          </el-button>
        </div>
      </template>
      <TaskWorkspace
        :key="workspaceTaskId"
        :task-id="workspaceTaskId"
        :goal="summaryQuery.data.value?.currentTask?.goal"
        :invalidate-on-done="[qk.leads.all, qk.leadHunterSummary, qk.employees.all]"
      >
        <template #done>
          <el-button type="primary" @click="goDiscover">{{ t('leadGen.viewLeads') }} →</el-button>
        </template>
      </TaskWorkspace>
    </el-card>

    <!-- 创建任务：自然语言 + 结构化补充（04 §3.3） -->
    <el-card shadow="never" class="lead-gen__create">
      <template #header>
        <span>{{ t('leadGen.createTitle') }}</span>
      </template>
      <el-form label-position="top" @submit.prevent>
        <el-form-item :label="t('leadGen.goalLabel')">
          <div class="lead-gen__goal-row">
            <el-input
              v-model="goalText"
              type="textarea"
              :rows="3"
              :placeholder="t('leadGen.goalPlaceholder')"
            />
            <el-button :loading="parsing" :disabled="parsing" @click="onParse">
              {{ parsing ? t('leadGen.parsing') : `✨ ${t('leadGen.parse')}` }}
            </el-button>
          </div>
        </el-form-item>

        <template v-if="parsed">
          <el-divider content-position="left">{{ t('leadGen.parseResult') }}</el-divider>
          <div class="lead-gen__parsed-grid">
            <el-form-item :label="t('leadGen.parsedTargetMarket')">
              <el-input v-model="form.targetMarket" />
            </el-form-item>
            <el-form-item :label="t('leadGen.parsedCustomerType')">
              <el-input v-model="form.customerType" />
            </el-form-item>
            <el-form-item :label="t('leadGen.parsedProduct')">
              <el-input v-model="form.targetProduct" />
            </el-form-item>
            <el-form-item :label="t('leadGen.parsedSize')">
              <el-input v-model="form.companySize" />
            </el-form-item>
          </div>
          <el-tag size="small" type="info" class="lead-gen__confidence">
            {{ t('leadGen.confidence') }}: {{ Math.round(parsed.confidence * 100) }}%
          </el-tag>
        </template>

        <el-collapse class="lead-gen__advanced">
          <el-collapse-item :title="t('leadGen.advanced')" name="advanced">
            <div class="lead-gen__parsed-grid">
              <el-form-item :label="t('leadGen.targetCount')">
                <el-input-number v-model="form.targetCount" :min="5" :max="200" :step="5" />
              </el-form-item>
              <el-form-item :label="t('leadGen.thresholdHigh')">
                <el-input-number v-model="form.thresholdHigh" :min="50" :max="100" />
              </el-form-item>
              <el-form-item :label="t('leadGen.thresholdMedium')">
                <el-input-number v-model="form.thresholdMedium" :min="20" :max="80" />
              </el-form-item>
            </div>
          </el-collapse-item>
        </el-collapse>

        <div class="lead-gen__actions">
          <el-button type="primary" :loading="submitting" :disabled="submitting" @click="onCreate">
            {{ t('leadGen.createTask') }}
          </el-button>
          <span class="lead-gen__tip">{{ t('leadGen.createTaskTip') }}</span>
        </div>
      </el-form>
    </el-card>
  </div>
</template>

<style scoped lang="scss">
.lead-gen {
  &__header {
    margin-bottom: 16px;
  }

  &__hunter {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
  }

  &__hunter-info {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  &__hunter-name {
    font-size: 16px;
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__today {
    display: flex;
    gap: 32px;
  }

  &__today-item {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  &__today-num {
    font-size: 22px;
    font-weight: 700;
    color: var(--tp-text-primary);

    &.is-high {
      color: var(--ai-working);
    }
  }

  &__today-label {
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__current {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }

  &__current-label {
    font-weight: 600;
    color: var(--tp-text-primary);
    white-space: nowrap;
  }

  &__current-goal {
    color: var(--tp-text-secondary);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 40%;
  }

  &__current-progress {
    flex: 1;
    min-width: 160px;
  }

  &__current-empty {
    flex: 1;
    color: var(--tp-text-tertiary);
    font-size: 13px;
  }

  &__workspace {
    margin-bottom: 16px;
  }

  &__card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-weight: 600;
  }

  &__goal-row {
    display: flex;
    gap: 12px;
    width: 100%;
    align-items: flex-start;
  }

  &__parsed-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 0 24px;
    width: 100%;
  }

  &__confidence {
    margin-bottom: 12px;
  }

  &__advanced {
    margin-bottom: 16px;
  }

  &__actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  &__tip {
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }
}
</style>
