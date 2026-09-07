<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMutation } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'

import { createCustomer, updateCustomer } from '@/api/resources/customers'
import type { ApiError } from '@/api/http'
import type { CustomerItem, CustomerType } from '@/api/types/customers'
import type { CustomerStage } from '@/utils/enum-map'
import { useAuthStore } from '@/stores/auth'
import { useDictStore } from '@/stores/dict'
import { usePermission } from '@/composables/usePermission'
import { isEmail } from '@/utils/validate'

/** owner 候选（当前用户 + 团队成员） */
export interface OwnerOption {
  value: string
  label: string
}

interface ContactRow {
  name: string
  title?: string
  email?: string
}

const props = withDefaults(
  defineProps<{
    /** 弹层显隐（v-model） */
    modelValue: boolean
    mode?: 'create' | 'edit'
    /** 编辑目标（行数据，05 §1.1 含编辑所需字段） */
    customer?: CustomerItem | null
    ownerOptions?: OwnerOption[]
  }>(),
  { mode: 'create', customer: null, ownerOptions: () => [] },
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** 保存成功（父级负责 invalidate 列表） */
  saved: []
}>()

const { t } = useI18n()
const auth = useAuthStore()
const dict = useDictStore()
const { canManage } = usePermission()

const dialogVisible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
})

interface CustomerFormState {
  companyName: string
  country: string
  website: string
  industry: string
  customerType: CustomerType
  isFormal: boolean
  stage: CustomerStage
  ownerId: string
  contacts: ContactRow[]
  remark: string
}

function defaultForm(): CustomerFormState {
  return {
    companyName: '',
    country: '',
    website: '',
    industry: '',
    customerType: 'other',
    isFormal: false,
    stage: 'new_lead',
    // 负责人默认当前用户（05 §1.2）
    ownerId: auth.user?.userId ?? '',
    contacts: [{ name: '', title: '', email: '' }],
    remark: '',
  }
}

const form = reactive<CustomerFormState>(defaultForm())
const formRef = ref<FormInstance>()

/** 当前用户是否出现在 owner 候选（edit 转交需要把原 owner 也并入，避免选中项丢失） */
function defaultOwnerId(): string {
  if (props.ownerOptions.some((o) => o.value === auth.user?.userId)) {
    return auth.user?.userId ?? ''
  }
  return props.ownerOptions[0]?.value ?? ''
}

watch(
  () => [props.modelValue, props.mode, props.customer] as const,
  ([visible]) => {
    if (!visible) return
    const initial = defaultForm()
    Object.assign(form, initial)
    if (props.mode === 'edit' && props.customer) {
      Object.assign(form, {
        companyName: props.customer.companyName,
        country: props.customer.country ?? '',
        website: props.customer.website ?? '',
        industry: props.customer.industry ?? '',
        customerType: props.customer.customerType ?? 'other',
        isFormal: props.customer.isFormal,
        stage: props.customer.stage,
        ownerId: props.customer.ownerId ?? defaultOwnerId(),
        remark: props.customer.remark ?? '',
      })
    } else {
      form.ownerId = defaultOwnerId()
    }
    formRef.value?.clearValidate()
  },
  { immediate: true },
)

const isEditLocked = computed(() => props.mode === 'edit' && props.customer?.deleteLocked)

// ===== 校验（05 §1.2） =====
const rules = computed<FormRules>(() => ({
  companyName: [{ required: true, message: t('crm.companyRequired'), trigger: 'blur' }],
  country: [{ required: true, message: t('crm.countryRequired'), trigger: 'change' }],
  ownerId: [{ required: true, message: t('crm.ownerRequired'), trigger: 'change' }],
  stage: [{ required: true, message: t('crm.stageRequired'), trigger: 'change' }],
}))

function validateContacts(): boolean {
  for (const row of form.contacts) {
    const hasAny = Boolean(row.name || row.email || row.title)
    if (!hasAny) continue
    if (!row.name) {
      ElMessage.warning(t('crm.contactNameRequired'))
      return false
    }
    if (row.email && !isEmail(row.email)) {
      ElMessage.warning(t('crm.emailInvalid'))
      return false
    }
  }
  return true
}

const saveMutation = useMutation({
  mutationFn: async () => {
    const payload = {
      companyName: form.companyName,
      country: form.country,
      website: form.website || undefined,
      industry: form.industry || undefined,
      customerType: form.customerType,
      isFormal: form.isFormal,
      ownerId: form.ownerId,
      remark: form.remark || undefined,
    }
    if (props.mode === 'edit' && props.customer) {
      return updateCustomer(props.customer.customerId, payload)
    }
    const contacts = form.contacts
      .filter((c) => c.name)
      .map((c) => ({ name: c.name, title: c.title || undefined, email: c.email || undefined }))
    return createCustomer({ ...payload, stage: form.stage, contacts })
  },
  onSuccess: () => {
    ElMessage.success(t(props.mode === 'edit' ? 'crm.saved' : 'crm.created'))
    emit('saved')
    dialogVisible.value = false
  },
  onError: (error: ApiError) => {
    if (error.code === 40301) {
      ElMessage.error(t('crm.reassignForbidden'))
      return
    }
    ElMessage.error(error.message || t('common.operationFailed'))
  },
})

async function submit() {
  if (saveMutation.isPending.value) return
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  if (props.mode === 'create' && !validateContacts()) return
  saveMutation.mutate()
}

async function removeContact(index: number) {
  // 单行时可整行清空，不立即删除（保持表单可逆）
  if (form.contacts.length === 1) {
    form.contacts[0] = { name: '', title: '', email: '' }
    return
  }
  form.contacts.splice(index, 1)
}
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    :title="t(mode === 'edit' ? 'crm.editCustomer' : 'crm.addCustomer')"
    width="620px"
    :close-on-click-modal="false"
    :append-to-body="true"
  >
    <el-alert
      v-if="isEditLocked"
      :title="t('crm.deletePendingTag')"
      type="warning"
      :closable="false"
      class="customer-form__locked"
      show-icon
    />
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-width="110px"
      label-position="right"
      class="customer-form"
    >
      <el-form-item :label="t('crm.company')" prop="companyName">
        <el-input v-model="form.companyName" :disabled="isEditLocked" maxlength="80" />
      </el-form-item>

      <div class="customer-form__row">
        <el-form-item :label="t('crm.country')" prop="country" class="customer-form__half">
          <el-select v-model="form.country" :disabled="isEditLocked" style="width: 100%">
            <el-option
              v-for="opt in dict.options('country')"
              :key="opt.value"
              :value="opt.value"
              :label="dict.label('country', opt.value)"
            />
          </el-select>
        </el-form-item>
        <el-form-item
          :label="t('crm.customerType')"
          prop="customerType"
          class="customer-form__half"
        >
          <el-select v-model="form.customerType" :disabled="isEditLocked" style="width: 100%">
            <el-option
              v-for="opt in dict.options('customerType')"
              :key="opt.value"
              :value="opt.value"
              :label="dict.label('customerType', opt.value)"
            />
          </el-select>
        </el-form-item>
      </div>

      <el-form-item :label="t('crm.industry')" prop="industry">
        <el-input
          v-model="form.industry"
          :disabled="isEditLocked"
          :placeholder="t('crm.industryPlaceholder')"
          maxlength="40"
        />
      </el-form-item>

      <el-form-item :label="t('crm.website')" prop="website">
        <el-input
          v-model="form.website"
          :disabled="isEditLocked"
          :placeholder="t('crm.websitePlaceholder')"
          maxlength="120"
        />
      </el-form-item>

      <div class="customer-form__row">
        <el-form-item :label="t('crm.identity')" prop="isFormal" class="customer-form__half">
          <el-radio-group v-model="form.isFormal" :disabled="isEditLocked">
            <el-radio-button :value="false">{{ t('crm.potential') }}</el-radio-button>
            <el-radio-button :value="true">{{ t('crm.formal') }}</el-radio-button>
          </el-radio-group>
          <div class="customer-form__hint">{{ t('crm.identityHint') }}</div>
        </el-form-item>
        <el-form-item
          v-if="mode === 'create'"
          :label="t('crm.initialStage')"
          prop="stage"
          class="customer-form__half"
        >
          <el-select v-model="form.stage" style="width: 100%">
            <el-option
              v-for="opt in dict.options('customerStage')"
              :key="opt.value"
              :value="opt.value"
              :label="dict.label('customerStage', opt.value)"
            />
          </el-select>
        </el-form-item>
      </div>

      <el-form-item :label="t('crm.owner')" prop="ownerId">
        <el-select
          v-model="form.ownerId"
          :disabled="isEditLocked || (!canManage && mode === 'edit')"
          style="width: 100%"
        >
          <el-option
            v-for="opt in ownerOptions"
            :key="opt.value"
            :value="opt.value"
            :label="opt.label"
          />
        </el-select>
        <div class="customer-form__hint">
          {{ mode === 'edit' ? t('crm.ownerTransferHint') : t('crm.ownerHint') }}
        </div>
      </el-form-item>

      <!-- 联系人子表单：仅新建携带（05 §1.2，编辑走联系人页签） -->
      <el-form-item v-if="mode === 'create'" :label="t('crm.contactSection')">
        <div class="customer-form__contacts">
          <div
            v-for="(contact, index) in form.contacts"
            :key="index"
            class="customer-form__contact"
          >
            <el-input
              v-model="contact.name"
              :placeholder="t('crm.contactName')"
              style="width: 150px"
            />
            <el-input
              v-model="contact.title"
              :placeholder="t('crm.contactTitle')"
              style="width: 150px"
            />
            <el-input
              v-model="contact.email"
              :placeholder="t('crm.contactEmail')"
              style="width: 170px"
            />
            <el-button link type="danger" size="small" @click="removeContact(index)">
              {{ t('common.delete') }}
            </el-button>
          </div>
          <el-button
            link
            type="primary"
            size="small"
            @click="form.contacts.push({ name: '', title: '', email: '' })"
          >
            {{ t('crm.addContact') }}
          </el-button>
        </div>
      </el-form-item>

      <el-form-item :label="t('crm.remark')" prop="remark">
        <el-input
          v-model="form.remark"
          :disabled="isEditLocked"
          :placeholder="t('crm.remarkPlaceholder')"
          type="textarea"
          :rows="2"
          maxlength="300"
          show-word-limit
        />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="dialogVisible = false">{{ t('common.cancel') }}</el-button>
      <el-button
        v-if="!isEditLocked"
        type="primary"
        :loading="saveMutation.isPending.value"
        @click="submit"
      >
        {{ t('common.save') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped lang="scss">
.customer-form {
  &__row {
    display: flex;
    gap: 16px;
  }

  &__half {
    flex: 1;
  }

  &__hint {
    width: 100%;
    font-size: 12px;
    line-height: 1.5;
    color: var(--tp-text-tertiary);
    margin-top: 2px;
  }

  &__contacts {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  &__contact {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  &__locked {
    margin-bottom: 16px;
  }
}
</style>
