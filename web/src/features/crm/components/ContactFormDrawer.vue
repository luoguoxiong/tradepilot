<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMutation, useQuery } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'

import { createContact, getCustomers, updateContact } from '@/api/resources/customers'
import type { ApiError } from '@/api/http'
import type { ContactItem } from '@/api/types/customers'
import { qk } from '@/query/keys'
import { staleTime } from '@/query/options'
import { isEmail } from '@/utils/validate'

/**
 * ContactFormDrawer 联系人新增/编辑表单（05 §1.3 / §2；02 §4.3 编辑走 Drawer）：
 * - create：所属客户必选（ER customer_id NOT NULL）+ 姓名/职位/邮箱；
 * - edit：归属不可变更（只读展示公司名），仅编辑姓名/职位/邮箱；
 * - 普通写操作（owner 权限内）：不走审批、不写客户活动；邮箱 org 内唯一（40901）。
 */
const props = withDefaults(
  defineProps<{
    /** 抽屉显隐（v-model） */
    modelValue: boolean
    mode?: 'create' | 'edit'
    /** 编辑目标（联系人页签行数据） */
    contact?: ContactItem | null
  }>(),
  { mode: 'create', contact: null },
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** 保存成功（父级负责 invalidate 联系人列表） */
  saved: []
}>()

const { t } = useI18n()

const drawerVisible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
})

interface ContactFormState {
  customerId: string
  name: string
  title: string
  email: string
}

function defaultForm(): ContactFormState {
  return { customerId: '', name: '', title: '', email: '' }
}

const form = reactive<ContactFormState>(defaultForm())
const formRef = ref<FormInstance>()

watch(
  () => [props.modelValue, props.mode, props.contact] as const,
  ([visible]) => {
    if (!visible) return
    Object.assign(form, defaultForm())
    if (props.mode === 'edit' && props.contact) {
      Object.assign(form, {
        customerId: props.contact.customerId,
        name: props.contact.name,
        title: props.contact.title ?? '',
        email: props.contact.email ?? '',
      })
    }
    formRef.value?.clearValidate()
  },
  { immediate: true },
)

// ===== 所属客户候选（仅 create；pageSize 上限 100，接口规范 §2.3） =====
const customersQuery = useQuery({
  queryKey: qk.customers.list({ pageSize: 100 }),
  queryFn: () => getCustomers({ pageSize: 100 }),
  staleTime: staleTime.LIST,
  enabled: computed(() => props.modelValue && props.mode === 'create'),
})

// ===== 校验（05 §1.3；邮箱可选、org 内唯一） =====
const rules = computed<FormRules>(() => ({
  customerId: [{ required: true, message: t('crm.contactCompanyRequired'), trigger: 'change' }],
  name: [{ required: true, message: t('crm.contactNameRequired'), trigger: 'blur' }],
  email: [{ validator: validateEmail, trigger: 'blur' }],
}))

function validateEmail(_rule: unknown, value: string, callback: (error?: Error) => void) {
  if (!value || isEmail(value)) callback()
  else callback(new Error(t('crm.emailInvalid')))
}

const saveMutation = useMutation({
  mutationFn: () => {
    const payload = {
      name: form.name,
      title: form.title || undefined,
      email: form.email || undefined,
    }
    if (props.mode === 'edit' && props.contact) {
      return updateContact(props.contact.contactId, payload)
    }
    return createContact({ ...payload, customerId: form.customerId })
  },
  onSuccess: () => {
    ElMessage.success(t(props.mode === 'edit' ? 'crm.contactSaved' : 'crm.contactCreated'))
    emit('saved')
    drawerVisible.value = false
  },
  onError: (error: ApiError) => {
    // 40901：邮箱已被其他联系人使用（ER uq_contact_org_email）
    if (error.code === 40901) {
      ElMessage.error(t('crm.contactEmailExists'))
      return
    }
    ElMessage.error(error.message || t('common.operationFailed'))
  },
})

async function submit() {
  if (saveMutation.isPending.value) return
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  saveMutation.mutate()
}
</script>

<template>
  <el-drawer
    v-model="drawerVisible"
    :title="t(mode === 'edit' ? 'crm.editContact' : 'crm.addContactButton')"
    size="420px"
    :close-on-click-modal="false"
    append-to-body
  >
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-width="90px"
      label-position="right"
      class="contact-form"
    >
      <el-form-item :label="t('crm.contactCompany')" prop="customerId">
        <el-select
          v-if="mode === 'create'"
          v-model="form.customerId"
          filterable
          :placeholder="t('crm.contactCompanyPlaceholder')"
          style="width: 100%"
        >
          <el-option
            v-for="customer in customersQuery.data.value?.list ?? []"
            :key="customer.customerId"
            :value="customer.customerId"
            :label="customer.companyName"
          />
        </el-select>
        <span v-else>{{ contact?.companyName }}</span>
      </el-form-item>

      <el-form-item :label="t('crm.contactName')" prop="name">
        <el-input v-model="form.name" maxlength="80" />
      </el-form-item>

      <el-form-item :label="t('crm.contactTitle')" prop="title">
        <el-input v-model="form.title" maxlength="80" />
      </el-form-item>

      <el-form-item :label="t('crm.contactEmail')" prop="email">
        <el-input v-model="form.email" placeholder="name@company.com" maxlength="120" />
        <div class="contact-form__hint">{{ t('crm.contactEmailHint') }}</div>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="drawerVisible = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="saveMutation.isPending.value" @click="submit">
        {{ t('common.save') }}
      </el-button>
    </template>
  </el-drawer>
</template>

<style scoped lang="scss">
.contact-form {
  &__hint {
    width: 100%;
    font-size: 12px;
    line-height: 1.5;
    color: var(--tp-text-tertiary);
    margin-top: 2px;
  }
}
</style>
