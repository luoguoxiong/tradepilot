<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'

import { ApiError } from '@/api/http'
import { useAuthStore } from '@/stores/auth'

/** 登录（16 v0.4）：邮箱+密码，失败统一提示防账号枚举 */
const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const authStore = useAuthStore()

const formRef = ref<FormInstance>()
const loading = ref(false)
const form = reactive({ email: '', password: '' })

const rules: FormRules = {
  email: [
    { required: true, message: t('auth.emailPlaceholder'), trigger: 'blur' },
    { type: 'email', message: t('auth.emailPlaceholder'), trigger: ['blur', 'change'] },
  ],
  password: [
    { required: true, message: t('auth.passwordPlaceholder'), trigger: 'blur' },
    { min: 8, message: t('auth.passwordRule'), trigger: ['blur', 'change'] },
  ],
}

/** redirect 仅允许站内相对路径，防开放重定向（05 §4.2） */
function safeRedirect(): string {
  const redirect = route.query.redirect
  if (typeof redirect === 'string' && redirect.startsWith('/') && !redirect.startsWith('//')) {
    return redirect
  }
  return '/dashboard'
}

async function submit() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  loading.value = true
  try {
    await authStore.login(form)
    await router.replace(safeRedirect())
  } catch (error) {
    // 统一防枚举提示（mock 与服务端同文案）
    ElMessage.error(error instanceof ApiError ? error.message : t('auth.loginFailed'))
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <el-card class="login-view" shadow="never">
    <h1 class="login-view__title">{{ t('auth.loginTitle') }}</h1>
    <p class="login-view__subtitle">{{ t('auth.loginSubtitle') }}</p>

    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-position="top"
      size="large"
      @keyup.enter="submit"
    >
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
          autocomplete="current-password"
        />
      </el-form-item>
      <el-button
        class="login-view__submit"
        type="primary"
        size="large"
        :loading="loading"
        @click="submit"
      >
        {{ loading ? t('auth.loggingIn') : t('auth.login') }}
      </el-button>
    </el-form>

    <div class="login-view__footer">
      <RouterLink to="/register">{{ t('auth.toRegister') }}</RouterLink>
    </div>
  </el-card>
</template>

<style scoped lang="scss">
.login-view {
  width: 400px;
  border-radius: var(--tp-border-radius-base);

  &__title {
    margin: 0 0 8px;
    font-size: 20px;
    text-align: center;
  }

  &__subtitle {
    margin: 0 0 24px;
    font-size: 13px;
    color: var(--tp-text-tertiary);
    text-align: center;
  }

  &__submit {
    width: 100%;
  }

  &__footer {
    margin-top: 16px;
    text-align: center;
  }
}
</style>
