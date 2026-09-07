<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'

import StepWizard from '@/components/business/StepWizard.vue'
import { createEmployee } from '@/api/resources/employees'
import type { CreateEmployeeReq, EmployeeRole, RoleTemplate } from '@/api/types/employees'

/**
 * 创建 AI 员工分步向导（02 PRD §3.1，v0.2/v0.3 决策）：
 * ① 选择角色（预载模板）→ ② 目标与 SOP（模板 + 参数级微调，不开放结构编辑）
 * → ③ 能力配置 → ④ 权限与 KPI；逐步校验，提交 POST /ai-employees（仅 admin/manager）。
 */
const props = defineProps<{
  visible: boolean
  roles: RoleTemplate[]
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
  created: [employeeId: string]
}>()

const { t } = useI18n()

const WIZARD_STEPS = [
  { key: 'role', title: 'employees.step1' },
  { key: 'goal', title: 'employees.step2' },
  { key: 'ability', title: 'employees.step3' },
  { key: 'permission', title: 'employees.step4' },
]

const ROLE_ICONS: Record<EmployeeRole, string> = {
  lead_hunter: '🤖',
  customer_researcher: '🔍',
  sales: '💼',
  follow_up: '📧',
  merchandiser: '📦',
  manager: '👔',
}

const step = ref(1)
const selectedRole = ref<RoleTemplate | null>(null)
const submitting = ref(false)

const form = reactive({
  name: '',
  goal: '',
  sopParams: {} as Record<string, string | number>,
  skills: [] as string[],
  tools: [] as string[],
  knowledgeScope: [] as string[],
  retentionDays: 180,
  permissions: {} as Record<string, boolean>,
  approvalEmailSend: 'high_value_only' as 'always' | 'high_value_only',
  kpiTarget: 0,
})

/** 选中角色：预载模板预填 ②~④ 步（02 §3.1） */
function pickRole(template: RoleTemplate) {
  selectedRole.value = template
  form.name = template.name
  form.goal = template.goal
  form.sopParams = { ...template.sopParams }
  form.skills = [...template.skills]
  form.tools = [...template.tools]
  form.knowledgeScope = [...template.knowledgeScope]
  form.retentionDays = template.memoryConfig.retentionDays
  form.permissions = Object.fromEntries(template.tools.map((tool) => [tool, true]))
  form.kpiTarget = template.kpiConfig.target
}

function resetAll() {
  step.value = 1
  selectedRole.value = null
  form.name = ''
  form.goal = ''
  form.sopParams = {}
  form.skills = []
  form.tools = []
  form.knowledgeScope = []
  form.retentionDays = 180
  form.permissions = {}
  form.approvalEmailSend = 'high_value_only'
  form.kpiTarget = 0
}

/** SOP 数值参数读写代理（模板内不支持 as 断言） */
function numberParam(key: string): number {
  const value = form.sopParams[key]
  return typeof value === 'number' ? value : Number(value ?? 0)
}

function setNumberParam(key: string, value: unknown) {
  if (typeof value === 'number') form.sopParams[key] = value
}

watch(
  () => props.visible,
  (visible) => {
    if (visible) resetAll()
  },
)

const preloadedText = computed(() => {
  const tpl = selectedRole.value
  if (!tpl) return ''
  return t('employees.preloaded', {
    sop: 1,
    skills: tpl.skills.length,
    tools: tpl.tools.length,
    kpi: tpl.kpiConfig.target,
  })
})

/** 逐步校验（02 §3.1：校验通过方可进入下一步） */
function validateStep(current: number): boolean {
  if (current === 1 && !selectedRole.value) {
    ElMessage.warning(t('employees.roleHint'))
    return false
  }
  if (current === 2 && (!form.name.trim() || !form.goal.trim())) {
    ElMessage.warning(`${t('employees.name')} / ${t('employees.goal')}`)
    return false
  }
  if (current === 4 && form.kpiTarget <= 0) {
    ElMessage.warning(t('employees.kpiTarget'))
    return false
  }
  return true
}

function next() {
  if (!validateStep(step.value)) return
  step.value = Math.min(step.value + 1, 4)
}

function prev() {
  step.value = Math.max(step.value - 1, 1)
}

async function submit() {
  if (!validateStep(4) || !selectedRole.value) return
  submitting.value = true
  try {
    const tpl = selectedRole.value
    const req: CreateEmployeeReq = {
      role: tpl.role,
      name: form.name.trim(),
      goal: form.goal.trim(),
      sopTemplateId: tpl.sopTemplateId,
      sopParams: { ...form.sopParams },
      skills: form.skills,
      tools: form.tools,
      knowledgeScope: form.knowledgeScope,
      memoryConfig: { retentionDays: form.retentionDays, scope: tpl.memoryConfig.scope },
      permissions: { ...form.permissions },
      approvalPolicy: {
        email_send: form.approvalEmailSend,
        quote: 'always',
        autoExecute: [],
      },
      kpiConfig: { metric: tpl.kpiConfig.metric, target: form.kpiTarget, period: 'daily' },
    }
    const resp = await createEmployee(req)
    ElMessage.success(t('employees.createSuccess'))
    emit('created', resp.employeeId)
    emit('update:visible', false)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-drawer
    :model-value="props.visible"
    :title="t('employees.wizardTitle')"
    size="560px"
    destroy-on-close
    @update:model-value="emit('update:visible', $event)"
  >
    <StepWizard :steps="WIZARD_STEPS" :current="step" />

    <!-- ① 选择角色 -->
    <div v-if="step === 1" class="wizard__body">
      <p class="wizard__hint">{{ t('employees.roleHint') }}</p>
      <div class="wizard__roles">
        <button
          v-for="template in props.roles"
          :key="template.role"
          type="button"
          class="wizard__role-card"
          :class="{ 'is-active': selectedRole?.role === template.role }"
          @click="pickRole(template)"
        >
          <span class="wizard__role-icon">{{ ROLE_ICONS[template.role] }}</span>
          <span class="wizard__role-name">{{ template.name }}</span>
          <span class="wizard__role-en">{{ template.role }}</span>
        </button>
      </div>
      <p v-if="selectedRole" class="wizard__preloaded">{{ preloadedText }}</p>
    </div>

    <!-- ② 目标与 SOP（模板预填 + 参数微调） -->
    <div v-else-if="step === 2" class="wizard__body">
      <el-form label-position="top" @submit.prevent>
        <el-form-item :label="t('employees.name')">
          <el-input v-model="form.name" />
        </el-form-item>
        <el-form-item :label="t('employees.goal')">
          <el-input v-model="form.goal" type="textarea" :rows="3" />
        </el-form-item>
        <el-form-item :label="t('employees.sopTemplate')">
          <el-input :model-value="selectedRole?.sopTemplateId" disabled />
        </el-form-item>
        <template v-if="selectedRole?.sopParamDefs?.length">
          <el-divider content-position="left">{{ t('employees.sopParams') }}</el-divider>
          <el-form-item v-for="def in selectedRole.sopParamDefs" :key="def.key" :label="def.label">
            <el-select v-if="def.type === 'select'" v-model="form.sopParams[def.key]">
              <el-option
                v-for="option in def.options ?? []"
                :key="option.value"
                :value="option.value"
                :label="option.label"
              />
            </el-select>
            <el-input-number
              v-else
              :model-value="numberParam(def.key)"
              :placeholder="String(def.defaultValue)"
              @update:model-value="setNumberParam(def.key, $event)"
            />
          </el-form-item>
        </template>
      </el-form>
    </div>

    <!-- ③ 能力配置 -->
    <div v-else-if="step === 3" class="wizard__body">
      <el-form label-position="top" @submit.prevent>
        <el-form-item :label="t('employees.skills')">
          <el-checkbox-group v-model="form.skills">
            <el-checkbox v-for="skill in selectedRole?.skills ?? []" :key="skill" :value="skill">
              {{ skill }}
            </el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item :label="t('employees.tools')">
          <el-checkbox-group v-model="form.tools">
            <el-checkbox v-for="tool in selectedRole?.tools ?? []" :key="tool" :value="tool">
              {{ tool }}
            </el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item :label="t('employees.knowledgeScope')">
          <el-checkbox-group v-model="form.knowledgeScope">
            <el-checkbox
              v-for="scope in selectedRole?.knowledgeScope ?? []"
              :key="scope"
              :value="scope"
            >
              {{ scope }}
            </el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item :label="t('employees.memory')">
          <el-input-number v-model="form.retentionDays" :min="30" :max="730" :step="30" />
        </el-form-item>
      </el-form>
    </div>

    <!-- ④ 权限与 KPI -->
    <div v-else class="wizard__body">
      <el-form label-position="top" @submit.prevent>
        <el-form-item :label="t('employees.permissions')">
          <div v-for="tool in selectedRole?.tools ?? []" :key="tool" class="wizard__permission-row">
            <span>{{ tool }}</span>
            <el-switch v-model="form.permissions[tool]" />
          </div>
        </el-form-item>
        <el-form-item :label="t('employees.approvalPolicy')">
          <el-radio-group v-model="form.approvalEmailSend">
            <el-radio value="always">{{ t('employees.approvalAlways') }}</el-radio>
            <el-radio value="high_value_only">{{ t('employees.approvalHighValue') }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item :label="t('employees.kpiTarget')">
          <el-input-number v-model="form.kpiTarget" :min="1" :max="500" />
        </el-form-item>
      </el-form>
    </div>

    <template #footer>
      <el-button v-if="step > 1" @click="prev">{{ t('employees.prev') }}</el-button>
      <el-button v-if="step < 4" type="primary" @click="next">{{ t('employees.next') }}</el-button>
      <el-button v-else type="primary" :loading="submitting" @click="submit">
        {{ t('employees.submitCreate') }}
      </el-button>
    </template>
  </el-drawer>
</template>

<style scoped lang="scss">
.wizard {
  &__body {
    padding: 0 4px;
  }

  &__hint {
    margin: 0 0 12px;
    font-size: 13px;
    color: var(--tp-text-tertiary);
  }

  &__roles {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
  }

  &__role-card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: 14px;
    border: 1px solid var(--tp-border-light);
    border-radius: var(--tp-radius-base, 8px);
    background: var(--tp-bg-secondary, #fafafa);
    cursor: pointer;
    transition:
      border-color 0.2s,
      box-shadow 0.2s;

    &.is-active {
      border-color: var(--el-color-primary);
      box-shadow: 0 0 0 1px var(--el-color-primary);
    }
  }

  &__role-icon {
    font-size: 22px;
  }

  &__role-name {
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__role-en {
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__preloaded {
    margin: 14px 0 0;
    font-size: 12px;
    color: var(--el-color-primary);
  }

  &__permission-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 6px 0;
  }
}
</style>
