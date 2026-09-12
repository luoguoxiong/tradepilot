<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { FormInstance, FormRules } from 'element-plus'

import { handleApiError } from '@/api/error-handler'
import { useAuthStore } from '@/stores/auth'

/** 注册企业（16 v0.4）：成功后进入初始化向导（onboarding.currentStep = 1） */
const router = useRouter()
const { t } = useI18n()
const authStore = useAuthStore()

const formRef = ref<FormInstance>()
const loading = ref(false)
const form = reactive({ companyName: '', contactName: '', email: '', password: '' })

const rules: FormRules = {
  companyName: [{ required: true, message: t('auth.orgNamePlaceholder'), trigger: 'blur' }],
  contactName: [{ required: true, message: t('auth.contactNamePlaceholder'), trigger: 'blur' }],
  email: [
    { required: true, message: t('auth.emailPlaceholder'), trigger: 'blur' },
    { type: 'email', message: t('auth.emailPlaceholder'), trigger: ['blur', 'change'] },
  ],
  password: [
    { required: true, message: t('auth.passwordPlaceholder'), trigger: 'blur' },
    { min: 8, message: t('auth.passwordRule'), trigger: ['blur', 'change'] },
  ],
}

async function submit() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  loading.value = true
  try {
    await authStore.register(form)
    await router.replace('/onboarding')
  } catch (error) {
    handleApiError(error)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <el-card class="register-view" shadow="never">
    <h1 class="register-view__title">{{ t('auth.registerTitle') }}</h1>

    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-position="top"
      size="large"
      @keyup.enter="submit"
    >
      <el-form-item :label="t('auth.orgName')" prop="companyName">
        <el-input v-model="form.companyName" :placeholder="t('auth.orgNamePlaceholder')" />
      </el-form-item>
      <el-form-item :label="t('auth.contactName')" prop="contactName">
        <el-input v-model="form.contactName" :placeholder="t('auth.contactNamePlaceholder')" />
      </el-form-item>
      <el-form-item :label="t('auth.email')" prop="email">
        <el-input
          v-model="form.email"
          :placeholder="t('auth.emailPlaceholder')"
          autocomplete="email"
        />
      </el-form-item>
      <el-form-item :label="t('auth.password')" prop="password">
        <el-input
          v-model="form.password"
          type="password"
          show-password
          :placeholder="t('auth.passwordPlaceholder')"
          autocomplete="new-password"
        />
      </el-form-item>
      <el-button
        class="register-view__submit"
        type="primary"
        size="large"
        :loading="loading"
        @click="submit"
      >
        {{ t('auth.registerTitle') }}
      </el-button>
    </el-form>

    <div class="register-view__footer">
      <span>{{ t('auth.hasAccount') }}</span>
      <RouterLink to="/login">{{ t('auth.toLogin') }}</RouterLink>
    </div>
  </el-card>
</template>

<style scoped lang="scss">
.register-view {
  width: 400px;
  border-radius: var(--tp-border-radius-base);

  &__title {
    margin: 0 0 24px;
    font-size: 20px;
    text-align: center;
  }

  &__submit {
    width: 100%;
  }

  &__footer {
    margin-top: 16px;
    color: var(--tp-text-tertiary);
    text-align: center;
  }
}
</style>
