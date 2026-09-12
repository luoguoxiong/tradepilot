<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'

import { createMailbox, deleteMailbox, fetchMailboxes, testMailbox } from '@/api/resources/settings'
import { handleApiError } from '@/api/error-handler'
import type { Mailbox } from '@/api/types/settings'
import EmptyState from '@/components/business/EmptyState.vue'
import MailboxForm from '@/features/settings/components/MailboxForm.vue'
import { maskEmail } from '@/utils/format'
import { useDictStore } from '@/stores/dict'

/**
 * 邮箱连接（16 FR-05，P0）：多邮箱列表（账号脱敏）+ 连接测试（IMAP/SMTP 分别回显）+
 * 断连红色提示 + 重连/删除。
 */
const { t } = useI18n()
const dict = useDictStore()

const loading = ref(false)
const mailboxes = ref<Mailbox[]>([])
const testingId = ref<string | null>(null)

const dialogVisible = ref(false)
const creating = ref(false)

async function load() {
  loading.value = true
  try {
    mailboxes.value = await fetchMailboxes()
  } catch (error) {
    handleApiError(error)
  } finally {
    loading.value = false
  }
}

onMounted(load)

function syncScopeText(row: Mailbox): string {
  const folders = row.syncScope.folders
  const folderText =
    folders.includes('INBOX') && folders.includes('Sent')
      ? t('settings.foldersBoth')
      : folders.includes('INBOX')
        ? t('settings.foldersInboxOnly')
        : folders.join(', ')
  return t('settings.syncScopeText', { days: row.syncScope.historyDays, folders: folderText })
}

async function onTest(row: Mailbox) {
  testingId.value = row.mailboxId
  try {
    const result = await testMailbox(row.mailboxId)
    if (result.ok) {
      ElMessage.success(`IMAP: ${result.imap} · SMTP: ${result.smtp}`)
    } else {
      ElMessage.error(result.error ?? t('common.operationFailed'))
    }
    await load()
  } catch (error) {
    handleApiError(error)
  } finally {
    testingId.value = null
  }
}

async function onDelete(row: Mailbox) {
  const confirmed = await ElMessageBox.confirm(
    t('settings.deleteMailboxConfirm', { account: maskEmail(row.account) }),
    {
      type: 'warning',
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
    },
  ).catch(() => false)
  if (!confirmed) return
  try {
    await deleteMailbox(row.mailboxId)
    ElMessage.success(t('settings.saved'))
    await load()
  } catch (error) {
    handleApiError(error)
  }
}

async function onCreate(req: Parameters<typeof createMailbox>[0]) {
  creating.value = true
  try {
    const mailbox = await createMailbox(req)
    const result = await testMailbox(mailbox.mailboxId)
    if (result.ok) {
      ElMessage.success(`IMAP: ${result.imap} · SMTP: ${result.smtp}`)
    } else {
      ElMessage.warning(result.error ?? t('common.operationFailed'))
    }
    dialogVisible.value = false
    await load()
  } catch (error) {
    handleApiError(error)
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div v-loading="loading">
    <div class="mailboxes__toolbar">
      <el-button type="primary" @click="dialogVisible = true">{{
        t('settings.connectMailbox')
      }}</el-button>
    </div>

    <el-table :data="mailboxes" stripe>
      <el-table-column :label="t('settings.mailboxAccount')" min-width="200">
        <template #default="{ row }">
          <span class="mailboxes__account">{{ maskEmail(row.account) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('settings.mailboxProvider')" min-width="120">
        <template #default="{ row }">{{ dict.label('mailboxProvider', row.provider) }}</template>
      </el-table-column>
      <el-table-column :label="t('settings.syncScope')" min-width="160">
        <template #default="{ row }">{{ syncScopeText(row) }}</template>
      </el-table-column>
      <el-table-column :label="t('settings.status')" min-width="110">
        <template #default="{ row }">
          <span
            class="mailboxes__status"
            :style="{ color: dict.color('mailboxStatus', row.status) }"
          >
            {{ dict.label('mailboxStatus', row.status) }}
          </span>
        </template>
      </el-table-column>
      <el-table-column :label="t('settings.actions')" width="220" fixed="right">
        <template #default="{ row }">
          <el-button link size="small" :loading="testingId === row.mailboxId" @click="onTest(row)">
            {{
              row.status === 'connected' ? t('settings.testConnection') : t('settings.reconnect')
            }}
          </el-button>
          <el-button link size="small" type="danger" @click="onDelete(row)">
            {{ t('common.delete') }}
          </el-button>
        </template>
      </el-table-column>
      <template #empty>
        <EmptyState />
      </template>
    </el-table>

    <el-dialog
      v-model="dialogVisible"
      :title="t('settings.connectMailbox')"
      width="720px"
      destroy-on-close
    >
      <MailboxForm :submitting="creating" @submit="onCreate" />
    </el-dialog>
  </div>
</template>

<style scoped lang="scss">
.mailboxes {
  &__toolbar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: calc(var(--tp-spacing-base) * 3);
  }

  &__account {
    font-family: monospace;
  }

  &__status {
    font-weight: 500;
  }
}
</style>
