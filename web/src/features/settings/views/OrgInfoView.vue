<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules, UploadFile } from 'element-plus'

import { fetchOrg, updateOrg } from '@/api/resources/org'
import type { OrgProfile } from '@/api/types/org'
import { useAppStore } from '@/stores/app'
import { useAuthStore } from '@/stores/auth'
import { usePermission } from '@/composables/usePermission'
import { useFormLeaveGuard } from '@/composables/useFormLeaveGuard'

/**
 * 企业信息（16 FR-02 / FR-12，P0）：基础资料 + 区域与本地化 3 默认值 + 外发规则。
 * 仅管理员可编辑（05 §3.2）；timezone 变更仅对新排期生效不回溯。
 */
const { t } = useI18n()
const appStore = useAppStore()
const authStore = useAuthStore()
const { isAdmin } = usePermission()

const formRef = ref<FormInstance>()
const loading = ref(false)
const saving = ref(false)

const form = reactive<Partial<OrgProfile> & { sendRules: NonNullable<OrgProfile['sendRules']> }>({
  name: '',
  logo: '',
  country: '',
  industry: '',
  timezone: 'Asia/Shanghai',
  defaultCurrency: 'USD',
  defaultLanguage: 'zh-CN',
  sendRules: { timeWindowStart: '09:00', timeWindowEnd: '18:00', minTouchIntervalDays: 3 },
})

// 02 §6 表单离开拦截：加载完成后表单变更即置脏，保存成功复位
const loaded = ref(false)
const dirty = ref(false)
watch(
  form,
  () => {
    if (loaded.value && !saving.value) dirty.value = true
  },
  { deep: true },
)
useFormLeaveGuard({ isDirty: () => dirty.value })

const rules: FormRules = {
  name: [{ required: true, message: t('auth.orgNamePlaceholder'), trigger: 'blur' }],
  timezone: [{ required: true, message: t('settings.timezoneRequired'), trigger: 'change' }],
}

// 常用选项（MVP 静态清单；timezone/filterable allow-create 支持完整 IANA 值）
const TIMEZONES = [
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Australia/Sydney',
  'UTC',
]
const COUNTRIES = [
  '中国',
  '美国',
  '德国',
  '英国',
  '法国',
  '日本',
  '韩国',
  '新加坡',
  '澳大利亚',
  '加拿大',
]
const INDUSTRIES = [
  '体育用品',
  '纺织服装',
  '电子元器件',
  '机械设备',
  '家居用品',
  '汽配',
  '玩具',
  '美妆',
]
const CURRENCIES = ['USD', 'EUR', 'CNY', 'GBP', 'JPY', 'AUD']
const LANGUAGES = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
] as const

onMounted(async () => {
  loading.value = true
  try {
    const org = await fetchOrg()
    Object.assign(form, org, { sendRules: org.sendRules ?? form.sendRules })
    loaded.value = true
  } finally {
    loading.value = false
  }
})

function onLogoChange(file: UploadFile) {
  const raw = file.raw
  if (!raw) return
  if (!['image/png', 'image/jpeg'].includes(raw.type)) {
    ElMessage.error(t('settings.logoTypeError'))
    return
  }
  if (raw.size > 2 * 1024 * 1024) {
    ElMessage.error(t('settings.logoSizeError'))
    return
  }
  form.logo = URL.createObjectURL(raw)
}

async function save() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  saving.value = true
  try {
    const org = await updateOrg({
      name: form.name,
      logo: form.logo,
      country: form.country,
      industry: form.industry,
      timezone: form.timezone,
      defaultCurrency: form.defaultCurrency,
      defaultLanguage: form.defaultLanguage,
      sendRules: form.sendRules,
    })
    authStore.org = org
    // 界面语言跟随企业默认语言（MVP zh-CN/en）
    if (org.defaultLanguage && appStore.locale !== org.defaultLanguage) {
      appStore.setLocale(org.defaultLanguage)
    }
    ElMessage.success(t('settings.saved'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <el-form
    ref="formRef"
    v-loading="loading"
    class="org-info"
    :model="form"
    :rules="rules"
    label-width="140px"
    :disabled="!isAdmin"
    @submit.prevent
  >
    <el-form-item :label="t('auth.orgName')" prop="name">
      <el-input v-model="form.name" :placeholder="t('auth.orgNamePlaceholder')" />
    </el-form-item>

    <el-form-item :label="t('settings.logo')">
      <el-upload
        class="org-info__logo"
        :auto-upload="false"
        :show-file-list="false"
        accept=".png,.jpg,.jpeg"
        @change="onLogoChange"
      >
        <el-avatar v-if="form.logo" :size="64" :src="form.logo" />
        <el-button v-else>{{ t('settings.uploadLogo') }}</el-button>
      </el-upload>
      <span class="org-info__hint">{{ t('settings.logoHint') }}</span>
    </el-form-item>

    <el-form-item :label="t('settings.country')">
      <el-select
        v-model="form.country"
        filterable
        allow-create
        :placeholder="t('settings.country')"
      >
        <el-option v-for="item in COUNTRIES" :key="item" :value="item" :label="item" />
      </el-select>
    </el-form-item>

    <el-form-item :label="t('settings.industry')">
      <el-select
        v-model="form.industry"
        filterable
        allow-create
        :placeholder="t('settings.industry')"
      >
        <el-option v-for="item in INDUSTRIES" :key="item" :value="item" :label="item" />
      </el-select>
    </el-form-item>

    <el-divider content-position="left">{{ t('settings.localization') }}</el-divider>

    <el-form-item :label="t('settings.timezone')" prop="timezone">
      <el-select v-model="form.timezone" filterable allow-create>
        <el-option v-for="tz in TIMEZONES" :key="tz" :value="tz" :label="tz" />
      </el-select>
      <span class="org-info__hint">{{ t('settings.timezoneHint') }}</span>
    </el-form-item>

    <el-form-item :label="t('settings.defaultCurrency')" prop="defaultCurrency">
      <el-select v-model="form.defaultCurrency">
        <el-option
          v-for="currency in CURRENCIES"
          :key="currency"
          :value="currency"
          :label="currency"
        />
      </el-select>
      <span class="org-info__hint">{{ t('settings.currencyHint') }}</span>
    </el-form-item>

    <el-form-item :label="t('settings.defaultLanguage')" prop="defaultLanguage">
      <el-select v-model="form.defaultLanguage">
        <el-option
          v-for="lang in LANGUAGES"
          :key="lang.value"
          :value="lang.value"
          :label="lang.label"
        />
      </el-select>
      <span class="org-info__hint">{{ t('settings.languageHint') }}</span>
    </el-form-item>

    <el-divider content-position="left">{{ t('settings.sendRules') }}</el-divider>

    <el-form-item :label="t('settings.timeWindow')" required>
      <el-time-select
        v-model="form.sendRules.timeWindowStart"
        start="00:00"
        step="00:30"
        end="23:30"
        :placeholder="t('settings.windowStart')"
      />
      <span class="org-info__dash">–</span>
      <el-time-select
        v-model="form.sendRules.timeWindowEnd"
        start="00:00"
        step="00:30"
        end="23:30"
        :placeholder="t('settings.windowEnd')"
      />
      <span class="org-info__hint">{{ t('settings.windowHint') }}</span>
    </el-form-item>

    <el-form-item :label="t('settings.minTouchInterval')" required>
      <el-input-number
        v-model="form.sendRules.minTouchIntervalDays"
        :min="1"
        :max="30"
        controls-position="right"
      />
      <span class="org-info__hint">{{ t('settings.intervalHint') }}</span>
    </el-form-item>

    <el-form-item>
      <el-button v-permission.disabled="['admin']" type="primary" :loading="saving" @click="save">
        {{ t('common.save') }}
      </el-button>
    </el-form-item>
  </el-form>
</template>

<style scoped lang="scss">
.org-info {
  max-width: 640px;

  &__logo {
    display: flex;
    align-items: center;
  }

  &__hint {
    margin-left: 12px;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__dash {
    margin: 0 8px;
  }
}
</style>
