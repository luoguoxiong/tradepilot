<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'

import {
  createApiKey,
  createWebhook,
  deleteWebhook,
  fetchApiKeys,
  fetchWebhooks,
  revokeApiKey,
} from '@/api/resources/settings'
import { handleApiError } from '@/api/error-handler'
import {
  API_SCOPES,
  WEBHOOK_EVENTS,
  type ApiKey,
  type ApiScope,
  type Webhook,
  type WebhookEvent,
} from '@/api/types/settings'
import EmptyState from '@/components/business/EmptyState.vue'
import { usePermission } from '@/composables/usePermission'
import { formatInOrgTz } from '@/utils/date'

/**
 * API / Webhook（16 FR-11 / 后端技术方案 06 §5，P1）：
 * - API Key：`tpk_live_…` 明文仅创建时返回一次，列表仅展示前缀；撤销即时失效；
 * - Webhook：订阅 `{ url, events[], secret }`，secret 加密入库、永不回显；
 *   投递签名 `X-TP-Signature: t=…, v1=HMAC-SHA256(secret, t.body)`。
 * 凭证属敏感配置：读写均仅 admin（与后端 @Roles('admin') 一致）。
 */
const { t } = useI18n()
const { isAdmin } = usePermission()

const activeTab = ref<'apiKeys' | 'webhooks'>('apiKeys')
const loading = ref(false)

const apiKeys = ref<ApiKey[]>([])
const webhooks = ref<Webhook[]>([])

const SCOPE_LABEL_KEYS: Record<string, string> = {
  'customers:read': 'settings.scopeCustomersRead',
  'customers:write': 'settings.scopeCustomersWrite',
  'tasks:read': 'settings.scopeTasksRead',
  'tasks:write': 'settings.scopeTasksWrite',
  'quotes:read': 'settings.scopeQuotesRead',
  'quotes:write': 'settings.scopeQuotesWrite',
  'orders:read': 'settings.scopeOrdersRead',
  'orders:write': 'settings.scopeOrdersWrite',
  'analytics:read': 'settings.scopeAnalyticsRead',
}

const EVENT_LABEL_KEYS: Record<string, string> = {
  approval_pending: 'settings.webhookEvent.approvalPending',
  risk_alert: 'settings.webhookEvent.riskAlert',
  task_failed: 'settings.webhookEvent.taskFailed',
  'task.completed': 'settings.webhookEvent.taskCompleted',
  'approval.decided': 'settings.webhookEvent.approvalDecided',
  'message.received': 'settings.webhookEvent.messageReceived',
  'customer.created': 'settings.webhookEvent.customerCreated',
}

function scopeLabel(scope: string): string {
  const key = SCOPE_LABEL_KEYS[scope]
  return key ? t(key) : scope
}

function eventLabel(event: string): string {
  const key = EVENT_LABEL_KEYS[event]
  return key ? t(key) : event
}

async function load() {
  loading.value = true
  try {
    const [keys, hooks] = await Promise.all([fetchApiKeys(), fetchWebhooks()])
    apiKeys.value = keys
    webhooks.value = hooks
  } catch (error) {
    handleApiError(error)
  } finally {
    loading.value = false
  }
}

onMounted(load)

// ===== API Key =====

const apiKeyDialog = ref(false)
const apiKeySubmitting = ref(false)
const apiKeyFormRef = ref<FormInstance>()
const apiKeyForm = reactive<{ name: string; scopes: ApiScope[] }>({ name: '', scopes: [] })

const apiKeyRules: FormRules = {
  name: [{ required: true, message: t('settings.apiKeyNameRequired'), trigger: 'blur' }],
  scopes: [
    {
      validator: (_rule, value: string[], callback) => {
        callback(
          value && value.length > 0 ? undefined : new Error(t('settings.apiKeyScopesRequired')),
        )
      },
      trigger: 'change',
    },
  ],
}

const createdKey = ref<string | null>(null)
const createdDialog = ref(false)

function openApiKeyDialog() {
  apiKeyForm.name = ''
  apiKeyForm.scopes = []
  apiKeyDialog.value = true
}

async function submitApiKey() {
  const valid = await apiKeyFormRef.value?.validate().catch(() => false)
  if (!valid) return
  apiKeySubmitting.value = true
  try {
    const created = await createApiKey({ name: apiKeyForm.name, scopes: [...apiKeyForm.scopes] })
    apiKeyDialog.value = false
    createdKey.value = created.key
    createdDialog.value = true
    await load()
  } catch (error) {
    handleApiError(error)
  } finally {
    apiKeySubmitting.value = false
  }
}

function closeCreatedDialog() {
  createdDialog.value = false
  createdKey.value = null
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success(t('settings.copied'))
  } catch {
    ElMessage.error(t('common.operationFailed'))
  }
}

async function onRevokeApiKey(row: ApiKey) {
  const confirmed = await ElMessageBox.confirm(
    t('settings.revokeApiKeyConfirm', { name: row.name }),
    {
      type: 'warning',
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
    },
  ).catch(() => false)
  if (!confirmed) return
  try {
    await revokeApiKey(row.id)
    ElMessage.success(t('settings.apiKeyRevoked'))
    await load()
  } catch (error) {
    handleApiError(error)
  }
}

// ===== Webhook =====

const webhookDialog = ref(false)
const webhookSubmitting = ref(false)
const webhookFormRef = ref<FormInstance>()
const webhookForm = reactive<{ url: string; events: WebhookEvent[]; secret: string }>({
  url: '',
  events: [],
  secret: '',
})

const webhookRules: FormRules = {
  url: [
    { required: true, message: t('settings.webhookUrlRequired'), trigger: 'blur' },
    { type: 'url', message: t('settings.webhookUrlRequired'), trigger: 'blur' },
  ],
  events: [
    {
      validator: (_rule, value: string[], callback) => {
        callback(
          value && value.length > 0 ? undefined : new Error(t('settings.webhookEventsRequired')),
        )
      },
      trigger: 'change',
    },
  ],
  secret: [
    { required: true, min: 16, message: t('settings.webhookSecretRequired'), trigger: 'blur' },
  ],
}

function openWebhookDialog() {
  webhookForm.url = ''
  webhookForm.events = []
  webhookForm.secret = ''
  webhookDialog.value = true
}

function generateSecret() {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  webhookForm.secret = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function submitWebhook() {
  const valid = await webhookFormRef.value?.validate().catch(() => false)
  if (!valid) return
  webhookSubmitting.value = true
  try {
    await createWebhook({
      url: webhookForm.url,
      events: [...webhookForm.events],
      secret: webhookForm.secret,
    })
    webhookDialog.value = false
    ElMessage.success(t('settings.webhookCreated'))
    await load()
  } catch (error) {
    handleApiError(error)
  } finally {
    webhookSubmitting.value = false
  }
}

async function onDeleteWebhook(row: Webhook) {
  const confirmed = await ElMessageBox.confirm(t('settings.deleteWebhookConfirm'), {
    type: 'warning',
    confirmButtonText: t('common.confirm'),
    cancelButtonText: t('common.cancel'),
  }).catch(() => false)
  if (!confirmed) return
  try {
    await deleteWebhook(row.id)
    ElMessage.success(t('settings.webhookDeleted'))
    await load()
  } catch (error) {
    handleApiError(error)
  }
}
</script>

<template>
  <div v-loading="loading" class="open-api">
    <el-alert
      class="open-api__alert"
      type="info"
      :title="t('settings.apiKeysHint')"
      :closable="false"
      show-icon
    />
    <el-alert
      v-if="!isAdmin"
      class="open-api__alert"
      type="warning"
      :title="t('settings.adminOnlyHint')"
      :closable="false"
      show-icon
    />

    <el-tabs v-model="activeTab">
      <!-- ===== API Key ===== -->
      <el-tab-pane :label="t('settings.tabApiKeys')" name="apiKeys">
        <div class="open-api__toolbar">
          <el-button v-permission="['admin']" type="primary" @click="openApiKeyDialog">
            {{ t('settings.createApiKey') }}
          </el-button>
        </div>

        <el-table :data="apiKeys" stripe>
          <el-table-column :label="t('settings.apiKeyName')" min-width="140" prop="name" />
          <el-table-column :label="t('settings.apiKeyPrefix')" min-width="180">
            <template #default="{ row }">
              <span class="open-api__mono">{{ row.keyPrefix }}…</span>
            </template>
          </el-table-column>
          <el-table-column :label="t('settings.apiKeyScopes')" min-width="220">
            <template #default="{ row }">
              <el-tag
                v-for="scope in row.scopes"
                :key="scope"
                class="open-api__tag"
                size="small"
                effect="plain"
              >
                {{ scopeLabel(scope) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="t('settings.apiKeyStatus')" width="110">
            <template #default="{ row }">
              <el-tag
                :type="row.status === 'active' ? 'success' : 'info'"
                size="small"
                effect="light"
              >
                {{
                  row.status === 'active'
                    ? t('settings.apiKeyStatusActive')
                    : t('settings.apiKeyStatusRevoked')
                }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="t('settings.apiKeyLastUsed')" min-width="150">
            <template #default="{ row }">{{ formatInOrgTz(row.lastUsedAt) }}</template>
          </el-table-column>
          <el-table-column :label="t('settings.apiKeyCreatedAt')" min-width="150">
            <template #default="{ row }">{{ formatInOrgTz(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column :label="t('settings.actions')" width="100" fixed="right">
            <template #default="{ row }">
              <el-button
                v-if="row.status === 'active'"
                v-permission="['admin']"
                link
                size="small"
                type="danger"
                @click="onRevokeApiKey(row)"
              >
                {{ t('settings.revokeApiKey') }}
              </el-button>
            </template>
          </el-table-column>
          <template #empty>
            <EmptyState />
          </template>
        </el-table>
      </el-tab-pane>

      <!-- ===== Webhook ===== -->
      <el-tab-pane :label="t('settings.tabWebhooks')" name="webhooks">
        <div class="open-api__toolbar">
          <el-button v-permission="['admin']" type="primary" @click="openWebhookDialog">
            {{ t('settings.createWebhook') }}
          </el-button>
        </div>

        <el-table :data="webhooks" stripe>
          <el-table-column :label="t('settings.webhookUrl')" min-width="240">
            <template #default="{ row }">
              <span class="open-api__mono">{{ row.url }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="t('settings.webhookEvents')" min-width="240">
            <template #default="{ row }">
              <el-tag
                v-for="event in row.events"
                :key="event"
                class="open-api__tag"
                size="small"
                effect="plain"
              >
                {{ eventLabel(event) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="t('settings.status')" width="110">
            <template #default="{ row }">
              <el-tag
                :type="row.status === 'active' ? 'success' : 'info'"
                size="small"
                effect="light"
              >
                {{
                  row.status === 'active'
                    ? t('settings.webhookStatusActive')
                    : t('settings.webhookStatusDisabled')
                }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="t('settings.webhookCreatedAt')" min-width="150">
            <template #default="{ row }">{{ formatInOrgTz(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column :label="t('settings.actions')" width="100" fixed="right">
            <template #default="{ row }">
              <el-button
                v-permission="['admin']"
                link
                size="small"
                type="danger"
                @click="onDeleteWebhook(row)"
              >
                {{ t('common.delete') }}
              </el-button>
            </template>
          </el-table-column>
          <template #empty>
            <EmptyState />
          </template>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <!-- 创建 API Key -->
    <el-dialog
      v-model="apiKeyDialog"
      :title="t('settings.createApiKey')"
      width="560px"
      destroy-on-close
    >
      <el-form ref="apiKeyFormRef" :model="apiKeyForm" :rules="apiKeyRules" label-width="110px">
        <el-form-item :label="t('settings.apiKeyName')" prop="name">
          <el-input v-model="apiKeyForm.name" :placeholder="t('settings.apiKeyNamePlaceholder')" />
        </el-form-item>
        <el-form-item :label="t('settings.apiKeyScopes')" prop="scopes">
          <el-checkbox-group v-model="apiKeyForm.scopes">
            <el-checkbox v-for="scope in API_SCOPES" :key="scope" :value="scope">
              {{ scopeLabel(scope) }}
            </el-checkbox>
          </el-checkbox-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="apiKeyDialog = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="apiKeySubmitting" @click="submitApiKey">
          {{ t('common.confirm') }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 明文密钥一次性展示 -->
    <el-dialog
      v-model="createdDialog"
      :title="t('settings.apiKeyCreatedTitle')"
      width="560px"
      :close-on-click-modal="false"
      @close="closeCreatedDialog"
    >
      <el-alert
        class="open-api__alert"
        type="warning"
        :title="t('settings.apiKeyOnceWarning')"
        :closable="false"
        show-icon
      />
      <div class="open-api__secret">
        <span class="open-api__mono">{{ createdKey }}</span>
        <el-button link type="primary" @click="createdKey && copyText(createdKey)">
          {{ t('settings.copy') }}
        </el-button>
      </div>
      <template #footer>
        <el-button type="primary" @click="closeCreatedDialog">{{ t('common.close') }}</el-button>
      </template>
    </el-dialog>

    <!-- 创建 Webhook -->
    <el-dialog
      v-model="webhookDialog"
      :title="t('settings.createWebhook')"
      width="600px"
      destroy-on-close
    >
      <el-form ref="webhookFormRef" :model="webhookForm" :rules="webhookRules" label-width="110px">
        <el-form-item :label="t('settings.webhookUrl')" prop="url">
          <el-input v-model="webhookForm.url" :placeholder="t('settings.webhookUrlPlaceholder')" />
        </el-form-item>
        <el-form-item :label="t('settings.webhookEvents')" prop="events">
          <el-checkbox-group v-model="webhookForm.events">
            <el-checkbox v-for="event in WEBHOOK_EVENTS" :key="event" :value="event">
              {{ eventLabel(event) }}
            </el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item :label="t('settings.webhookSecret')" prop="secret">
          <el-input
            v-model="webhookForm.secret"
            :placeholder="t('settings.webhookSecretPlaceholder')"
          >
            <template #append>
              <el-button @click="generateSecret">{{ t('settings.generateSecret') }}</el-button>
            </template>
          </el-input>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="webhookDialog = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="webhookSubmitting" @click="submitWebhook">
          {{ t('common.confirm') }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped lang="scss">
.open-api {
  &__alert {
    margin-bottom: calc(var(--tp-spacing-base) * 3);
  }

  &__toolbar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: calc(var(--tp-spacing-base) * 3);
  }

  &__mono {
    font-family: monospace;
  }

  &__tag {
    margin: 0 6px 6px 0;
  }

  &__secret {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px;
    background: var(--tp-bg-fill);
    border-radius: var(--tp-border-radius-base);
    word-break: break-all;
  }
}
</style>
