<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FormInstance, FormRules } from 'element-plus'

import type { CreateMailboxReq, MailboxProvider } from '@/api/types/settings'
import { useDictStore } from '@/stores/dict'

/**
 * 邮箱连接表单（16 FR-05 / 接口文档 §3.3）：
 * 向导步骤 3 与 设置-邮箱连接 共用；凭据仅提交不回显。
 */
const props = withDefaults(defineProps<{ submitting?: boolean; submitText?: string }>(), {
  submitting: false,
  submitText: '',
})

const emit = defineEmits<{ submit: [req: CreateMailboxReq] }>()

const { t } = useI18n()
const dict = useDictStore()

const formRef = ref<FormInstance>()

const form = reactive({
  provider: 'smtp_imap' as MailboxProvider,
  account: '',
  imap: { host: '', port: 993, ssl: true, credential: '' },
  smtp: { host: '', port: 465, ssl: true, credential: '' },
  historyDays: 90,
  folders: ['INBOX', 'Sent'] as string[],
})

const rules: FormRules = {
  account: [
    { required: true, message: t('settings.mailboxAccountRequired'), trigger: 'blur' },
    { type: 'email', message: t('settings.mailboxAccountRequired'), trigger: ['blur', 'change'] },
  ],
  'imap.host': [{ required: true, message: t('settings.hostRequired'), trigger: 'blur' }],
  'smtp.host': [{ required: true, message: t('settings.hostRequired'), trigger: 'blur' }],
}

const providerOptions = dict.options('mailboxProvider')

function submit() {
  formRef.value?.validate((valid) => {
    if (!valid) return
    const req: CreateMailboxReq = {
      provider: form.provider,
      account: form.account,
      imap: { ...form.imap },
      smtp: { ...form.smtp },
      syncScope: { historyDays: form.historyDays, folders: [...form.folders] },
    }
    emit('submit', req)
  })
}
</script>

<template>
  <el-form
    ref="formRef"
    class="mailbox-form"
    :model="form"
    :rules="rules"
    label-width="120px"
    @submit.prevent
  >
    <el-form-item :label="t('settings.mailboxProvider')" required>
      <el-radio-group v-model="form.provider">
        <el-radio-button
          v-for="option in providerOptions"
          :key="option.value"
          :value="option.value"
        >
          {{ t(option.labelKey) }}
        </el-radio-button>
      </el-radio-group>
    </el-form-item>

    <el-form-item :label="t('settings.mailboxAccount')" prop="account">
      <el-input v-model="form.account" :placeholder="t('settings.mailboxAccountPlaceholder')" />
    </el-form-item>

    <el-form-item :label="t('settings.imap')" prop="imap.host">
      <div class="mailbox-form__channel">
        <el-input v-model="form.imap.host" :placeholder="t('settings.hostPlaceholder')" />
        <el-input-number v-model="form.imap.port" :min="1" :max="65535" controls-position="right" />
        <el-checkbox v-model="form.imap.ssl">SSL</el-checkbox>
        <el-input
          v-model="form.imap.credential"
          type="password"
          show-password
          :placeholder="t('settings.credential')"
        />
      </div>
    </el-form-item>

    <el-form-item :label="t('settings.smtp')" prop="smtp.host">
      <div class="mailbox-form__channel">
        <el-input v-model="form.smtp.host" :placeholder="t('settings.hostPlaceholder')" />
        <el-input-number v-model="form.smtp.port" :min="1" :max="65535" controls-position="right" />
        <el-checkbox v-model="form.smtp.ssl">SSL</el-checkbox>
        <el-input
          v-model="form.smtp.credential"
          type="password"
          show-password
          :placeholder="t('settings.credential')"
        />
      </div>
    </el-form-item>

    <el-form-item :label="t('settings.syncScope')" required>
      <div class="mailbox-form__scope">
        <span>{{ t('settings.historyDays') }}</span>
        <el-input-number v-model="form.historyDays" :min="1" :max="365" controls-position="right" />
        <el-checkbox-group v-model="form.folders">
          <el-checkbox value="INBOX">INBOX</el-checkbox>
          <el-checkbox value="Sent">Sent</el-checkbox>
        </el-checkbox-group>
      </div>
    </el-form-item>

    <slot name="footer">
      <div class="mailbox-form__footer">
        <el-button type="primary" :loading="props.submitting" @click="submit">
          {{ props.submitText || t('common.save') }}
        </el-button>
      </div>
    </slot>
  </el-form>
</template>

<style scoped lang="scss">
.mailbox-form {
  max-width: 720px;

  &__channel {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 8px;

    // 端口输入框固定宽度，避免被 flex 压缩到内部 input 宽度为 0 导致无法输入
    :deep(.el-input) {
      flex: 1 1 auto;
      min-width: 0;
    }

    :deep(.el-input-number) {
      flex: 0 0 130px;
      width: 130px;
    }

    :deep(.el-checkbox) {
      flex: 0 0 auto;
    }
  }

  &__scope {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 8px;
  }
}
</style>
