<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'

import { advanceOnboarding, fetchOnboarding } from '@/api/resources/org'
import { createMailbox, testMailbox } from '@/api/resources/settings'
import type { CreateMailboxReq } from '@/api/types/settings'
import MailboxForm from '@/features/settings/components/MailboxForm.vue'
import StepWizard from '@/components/business/StepWizard.vue'
import Uploader from '@/components/business/Uploader.vue'
import { useAuthStore } from '@/stores/auth'

/**
 * 企业初始化四步向导（16 v0.4 §2.3 / 排期 M2-4）：
 * 注册企业 → 上传产品资料 → 连接邮箱 → 完成；断点续走 onboarding.currentStep，步骤可跳过。
 */
const router = useRouter()
const { t } = useI18n()
const authStore = useAuthStore()

const STEPS = [
  { key: 'company', title: 'onboarding.step1' },
  { key: 'products', title: 'onboarding.step2' },
  { key: 'mailbox', title: 'onboarding.step3' },
  { key: 'done', title: 'onboarding.step4' },
]

const current = ref(1)
const loading = ref(false)
const savingMailbox = ref(false)
const testResult = ref<string | null>(null)

const orgName = computed(() => authStore.org?.name ?? '')

onMounted(async () => {
  loading.value = true
  try {
    const status = await fetchOnboarding()
    current.value = status.currentStep
    authStore.setOnboarding(status.currentStep)
  } finally {
    loading.value = false
  }
})

/** 推进步骤 + 同步会话持久化（守卫据 currentStep 放行，刷新后断点续走） */
async function goTo(step: number) {
  const status = await advanceOnboarding(step)
  current.value = status.currentStep
  authStore.setOnboarding(status.currentStep)
}

async function onNext(from: number) {
  await goTo(Math.max(current.value, from + 1))
}

async function onUploadAll() {
  ElMessage.success(t('onboarding.uploadDone'))
  await onNext(2)
}

async function onSaveMailbox(req: CreateMailboxReq) {
  savingMailbox.value = true
  testResult.value = null
  try {
    const mailbox = await createMailbox(req)
    const result = await testMailbox(mailbox.mailboxId)
    testResult.value = result.ok
      ? `IMAP: ${result.imap} · SMTP: ${result.smtp}`
      : (result.error ?? t('common.operationFailed'))
    if (!result.ok) {
      ElMessage.error(testResult.value)
      return
    }
    ElMessage.success(t('onboarding.mailboxConnected'))
    await onNext(3)
  } finally {
    savingMailbox.value = false
  }
}

async function finish() {
  await goTo(4)
  await router.replace('/dashboard')
}

async function goLeadGen() {
  await goTo(4)
  await router.replace('/lead-gen')
}
</script>

<template>
  <div v-loading="loading" class="onboarding">
    <div class="onboarding__panel">
      <h1 class="onboarding__title">{{ t('onboarding.title') }}</h1>
      <StepWizard :steps="STEPS" :current="current" />

      <!-- 步骤 1：注册企业（注册时已完成，展示确认信息） -->
      <section v-if="current === 1" class="onboarding__body">
        <el-result icon="success" :title="t('onboarding.companyReady')">
          <template #sub-title>
            <p>{{ t('auth.orgName') }}：{{ orgName }}</p>
          </template>
        </el-result>
        <div class="onboarding__actions">
          <el-button type="primary" @click="onNext(1)">{{ t('onboarding.next') }}</el-button>
        </div>
      </section>

      <!-- 步骤 2：上传产品资料（知识入库，同步知识中心 11） -->
      <section v-else-if="current === 2" class="onboarding__body">
        <Uploader
          action="/api/v1/knowledge/documents"
          accept=".pdf,.png,.jpg,.xlsx"
          @all-success="onUploadAll"
        />
        <div class="onboarding__actions">
          <el-button @click="onNext(2)">{{ t('onboarding.skip') }}</el-button>
          <el-button type="primary" @click="onNext(2)">{{ t('onboarding.next') }}</el-button>
        </div>
      </section>

      <!-- 步骤 3：连接邮箱（收发通道，16 FR-05） -->
      <section v-else-if="current === 3" class="onboarding__body">
        <MailboxForm
          :submitting="savingMailbox"
          :submit-text="t('onboarding.connectAndTest')"
          @submit="onSaveMailbox"
        />
        <el-alert
          v-if="testResult"
          class="onboarding__test-result"
          :title="testResult"
          :type="testResult.startsWith('IMAP') ? 'success' : 'error'"
          :closable="false"
        />
        <div class="onboarding__actions">
          <el-button @click="onNext(3)">{{ t('onboarding.skip') }}</el-button>
        </div>
      </section>

      <!-- 步骤 4：完成，引导创建首个获客任务（MVP 主流程 §23） -->
      <section v-else class="onboarding__body">
        <el-result
          icon="success"
          :title="t('onboarding.allDone')"
          :sub-title="t('onboarding.doneHint')"
        />
        <div class="onboarding__actions">
          <el-button @click="finish">{{ t('onboarding.goDashboard') }}</el-button>
          <el-button type="primary" @click="goLeadGen">{{
            t('onboarding.createLeadTask')
          }}</el-button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped lang="scss">
.onboarding {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: var(--tp-bg-page);

  &__panel {
    width: 720px;
    padding: calc(var(--tp-spacing-base) * 8);
    background: var(--tp-bg-container);
    border-radius: var(--tp-border-radius-base);
  }

  &__title {
    margin: 0 0 8px;
    font-size: 20px;
    text-align: center;
  }

  &__body {
    min-height: 280px;
    padding-top: calc(var(--tp-spacing-base) * 4);
  }

  &__actions {
    display: flex;
    justify-content: center;
    gap: calc(var(--tp-spacing-base) * 3);
    margin-top: calc(var(--tp-spacing-base) * 6);
  }

  &__test-result {
    margin-top: calc(var(--tp-spacing-base) * 4);
  }
}
</style>
