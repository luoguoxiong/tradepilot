<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'

import { createTask } from '@/api/resources/tasks'
import { handleApiError } from '@/api/error-handler'
import { useEmployeeOptions } from '../composables/useTasks'
import { useDictStore } from '@/stores/dict'
import type { EmployeeCard, EmployeeRole } from '@/api/types/employees'
import type { CreateTaskReq, TaskType } from '@/api/types/tasks'

/**
 * NewTaskDialog 新建任务（14 §3.2 / FR-02）：
 * `+ 新任务` 统一入口——跨员工下发，员工角色决定默认任务类型（type 决定 SOP 与队列归属），
 * 用户可覆盖类型并补充 SOP 输入参数（JSON）与可选定时执行时间。
 */
const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  saved: [taskId: string, status: 'running' | 'scheduled']
}>()

const { t } = useI18n()
const dict = useDictStore()

/** 与后端 taskType 枚举一致（14 §1.1） */
const TASK_TYPES: TaskType[] = [
  'lead_hunting',
  'email_reply',
  'follow_up',
  'order_monitor',
  'business_analysis',
  'knowledge_index',
  'product_analysis',
  'product_knowledge',
]

/** 员工角色 → 默认任务类型（type 决定 SOP，给出最常用映射后仍允许用户覆盖） */
const ROLE_DEFAULT_TYPE: Record<EmployeeRole, TaskType> = {
  lead_hunter: 'lead_hunting',
  customer_researcher: 'product_analysis',
  sales: 'email_reply',
  follow_up: 'follow_up',
  merchandiser: 'order_monitor',
  manager: 'business_analysis',
}

const formRef = ref<FormInstance>()
const submitting = ref(false)

const form = reactive({
  employeeId: '',
  type: '' as TaskType | '',
  title: '',
  input: '',
  scheduledAt: '' as string,
})

const { data: employees } = useEmployeeOptions()

const rules = computed<FormRules>(() => ({
  employeeId: [{ required: true, message: t('tasks.requiredEmployee'), trigger: 'change' }],
  type: [{ required: true, message: t('tasks.requiredType'), trigger: 'change' }],
  title: [{ required: true, message: t('tasks.requiredTitle'), trigger: 'blur' }],
}))

function resetForm() {
  form.employeeId = ''
  form.type = ''
  form.title = ''
  form.input = ''
  form.scheduledAt = ''
  formRef.value?.clearValidate()
}

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) resetForm()
  },
)

function employeeLabel(employee: EmployeeCard): string {
  return employee.name
}

/** 选择员工后自动带出默认类型（用户仍可手动改） */
function onEmployeeChange(employeeId: string) {
  const employee = (employees.value?.items ?? []).find((item) => item.employeeId === employeeId)
  if (employee) form.type = ROLE_DEFAULT_TYPE[employee.role]
}

/** 校验并解析 JSON 输入；空串视为 {} */
function parseInput(): Record<string, unknown> | undefined {
  const raw = form.input.trim()
  if (!raw) return undefined
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(t('tasks.inputInvalid'))
  }
  return parsed as Record<string, unknown>
}

async function submit() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  let input: Record<string, unknown> | undefined
  try {
    input = parseInput()
  } catch {
    ElMessage.error(t('tasks.inputInvalid'))
    return
  }

  submitting.value = true
  try {
    const payload: CreateTaskReq = {
      employeeId: form.employeeId,
      type: form.type as TaskType,
      title: form.title.trim(),
    }
    if (input) payload.input = input
    if (form.scheduledAt) payload.scheduledAt = new Date(form.scheduledAt).toISOString()

    const resp = await createTask(payload)
    ElMessage.success(
      resp.status === 'scheduled' ? t('tasks.createdScheduled') : t('tasks.created'),
    )
    emit('saved', resp.taskId, resp.status)
    emit('update:modelValue', false)
  } catch (error) {
    handleApiError(error)
  } finally {
    submitting.value = false
  }
}

function close() {
  emit('update:modelValue', false)
}
</script>

<template>
  <el-dialog
    :model-value="props.modelValue"
    :title="t('tasks.newTaskTitle')"
    width="620px"
    :close-on-click-modal="false"
    append-to-body
    @close="close"
  >
    <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
      <el-form-item :label="t('tasks.employee')" prop="employeeId">
        <el-select
          v-model="form.employeeId"
          filterable
          :placeholder="t('tasks.employeePlaceholder')"
          style="width: 100%"
          @change="onEmployeeChange"
        >
          <el-option
            v-for="employee in (employees?.items ?? []) as EmployeeCard[]"
            :key="employee.employeeId"
            :value="employee.employeeId"
            :label="employeeLabel(employee)"
          />
        </el-select>
      </el-form-item>

      <el-form-item :label="t('tasks.type')" prop="type">
        <el-select
          v-model="form.type"
          :placeholder="t('tasks.typePlaceholder')"
          style="width: 100%"
        >
          <el-option
            v-for="type in TASK_TYPES"
            :key="type"
            :value="type"
            :label="dict.label('taskType', type)"
          />
        </el-select>
      </el-form-item>

      <el-form-item :label="t('tasks.taskTitle')" prop="title">
        <el-input
          v-model="form.title"
          maxlength="120"
          :placeholder="t('tasks.taskTitlePlaceholder')"
        />
      </el-form-item>

      <el-form-item :label="t('tasks.scheduleAt')">
        <el-date-picker
          v-model="form.scheduledAt"
          type="datetime"
          value-format="YYYY-MM-DDTHH:mm:ss"
          :placeholder="t('tasks.scheduleHint')"
          style="width: 100%"
        />
      </el-form-item>

      <el-form-item :label="t('tasks.inputLabel')">
        <el-input
          v-model="form.input"
          type="textarea"
          :rows="4"
          :placeholder="t('tasks.inputHint')"
        />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="close">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="submitting" @click="submit">
        {{ t('common.save') }}
      </el-button>
    </template>
  </el-dialog>
</template>
