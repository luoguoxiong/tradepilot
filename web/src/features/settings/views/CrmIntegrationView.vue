<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'

import {
  createCrmIntegration,
  deleteCrmIntegration,
  fetchCrmIntegrations,
  updateCrmIntegration,
} from '@/api/resources/settings'
import { handleApiError } from '@/api/error-handler'
import {
  CRM_LOCAL_FIELDS,
  CRM_PROVIDERS,
  CRM_SYNC_DIRECTIONS,
  type CrmFieldMapping,
  type CrmIntegration,
  type CrmLocalField,
  type CrmProvider,
  type CrmSyncDirection,
} from '@/api/types/settings'
import EmptyState from '@/components/business/EmptyState.vue'
import { usePermission } from '@/composables/usePermission'
import { formatInOrgTz } from '@/utils/date'

/**
 * CRM 集成（16 §1.8 FR-06 / ER 01 §2.5，P1）：
 * 授权连接 → 字段映射 → 同步方向三件事的配置面（`crm_integration`，org 级可多条，同供应商唯一）。
 * 依据后端技术方案 06 §6，MVP 不做任何外呼：本页只负责把配置落库，
 * 实际拉取/推送由后续 `CrmDriver { pullCustomers / pushCustomer / mapFields }` 按 `syncDirection` 执行。
 * 读取 admin+manager、写入仅 admin（与后端 @Roles 一致）。
 */
const { t } = useI18n()
const { isAdmin } = usePermission()

const PROVIDER_LABEL_KEYS: Record<CrmProvider, string> = {
  xiaoman: 'settings.crmProviderXiaoman',
  futong: 'settings.crmProviderFutong',
}

const DIRECTION_LABEL_KEYS: Record<CrmSyncDirection, string> = {
  pull: 'settings.crmDirectionPull',
  push: 'settings.crmDirectionPush',
  both: 'settings.crmDirectionBoth',
}

const FIELD_LABEL_KEYS: Record<CrmLocalField, string> = {
  'customer.companyName': 'settings.crmFieldCustomerCompanyName',
  'customer.country': 'settings.crmFieldCustomerCountry',
  'customer.website': 'settings.crmFieldCustomerWebsite',
  'customer.industry': 'settings.crmFieldCustomerIndustry',
  'customer.remark': 'settings.crmFieldCustomerRemark',
  'contact.name': 'settings.crmFieldContactName',
  'contact.title': 'settings.crmFieldContactTitle',
  'contact.email': 'settings.crmFieldContactEmail',
  'contact.phone': 'settings.crmFieldContactPhone',
}

const loading = ref(false)
const integrations = ref<CrmIntegration[]>([])

function providerLabel(provider: CrmProvider): string {
  return t(PROVIDER_LABEL_KEYS[provider])
}

function directionLabel(direction: CrmSyncDirection): string {
  return t(DIRECTION_LABEL_KEYS[direction])
}

function fieldLabel(field: CrmLocalField): string {
  return t(FIELD_LABEL_KEYS[field])
}

onMounted(load)

async function load() {
  loading.value = true
  try {
    integrations.value = await fetchCrmIntegrations()
  } catch (error) {
    handleApiError(error)
  } finally {
    loading.value = false
  }
}

/** 已接入的供应商不可重复授权（后端 40901 前置拦截，降低无效请求） */
const connectedProviders = computed(() => new Set(integrations.value.map((it) => it.provider)))

function providerOptions(current?: CrmProvider): CrmProvider[] {
  return CRM_PROVIDERS.filter((p) => p === current || !connectedProviders.value.has(p))
}

/** 白名单供应商全部接入后不再提供新增入口，避免必然 409 的无效提交 */
const canAuthorize = computed(() => providerOptions().length > 0)

// ===== 授权 / 编辑 =====

const dialog = ref(false)
const submitting = ref(false)
const formRef = ref<FormInstance>()
/** null = 新增授权；否则为编辑中的集成 id */
const editingId = ref<string | null>(null)

const form = reactive<{
  provider: CrmProvider
  syncDirection: CrmSyncDirection
  mapping: CrmFieldMapping[]
}>({
  provider: 'xiaoman',
  syncDirection: 'both',
  mapping: [],
})

const isEditing = computed(() => editingId.value !== null)

const rules: FormRules = {
  provider: [{ required: true, message: t('settings.crmProviderRequired'), trigger: 'change' }],
  syncDirection: [
    { required: true, message: t('settings.crmDirectionRequired'), trigger: 'change' },
  ],
}

function openCreate() {
  const available = providerOptions()
  if (available.length === 0) {
    ElMessage.warning(t('settings.crmAllProvidersConnected'))
    return
  }
  editingId.value = null
  form.provider = available[0] ?? 'xiaoman'
  form.syncDirection = 'both'
  form.mapping = []
  dialog.value = true
}

function openEdit(row: CrmIntegration) {
  editingId.value = row.id
  form.provider = row.provider
  form.syncDirection = row.syncDirection
  form.mapping = (row.mapping ?? []).map((m) => ({ ...m }))
  dialog.value = true
}

function addMappingRow() {
  if (form.mapping.length >= CRM_LOCAL_FIELDS.length) {
    ElMessage.warning(t('settings.crmMappingFull'))
    return
  }
  const used = new Set(form.mapping.map((m) => m.local))
  const next = CRM_LOCAL_FIELDS.find((f) => !used.has(f))
  if (!next) {
    ElMessage.warning(t('settings.crmMappingFull'))
    return
  }
  form.mapping.push({ local: next, remote: '' })
}

function removeMappingRow(index: number) {
  form.mapping.splice(index, 1)
}

/** 已映射过的本地字段在其他行置灰，避免同一字段重复映射（后端 schema 亦会拦截） */
function availableFields(index: number): readonly CrmLocalField[] {
  const used = new Set(form.mapping.filter((_, i) => i !== index).map((m) => m.local))
  return CRM_LOCAL_FIELDS.filter((f) => !used.has(f))
}

async function submit() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  const filled = form.mapping.filter((m) => m.remote.trim() !== '')
  if (filled.length !== form.mapping.length) {
    ElMessage.error(t('settings.crmRemoteFieldRequired'))
    return
  }
  if (new Set(filled.map((m) => m.remote.trim())).size !== filled.length) {
    ElMessage.error(t('settings.crmRemoteFieldDuplicated'))
    return
  }
  submitting.value = true
  try {
    const mapping = filled.map((m) => ({ local: m.local, remote: m.remote.trim() }))
    if (editingId.value) {
      await updateCrmIntegration(editingId.value, {
        syncDirection: form.syncDirection,
        mapping: mapping.length > 0 ? mapping : null,
      })
    } else {
      await createCrmIntegration({
        provider: form.provider,
        syncDirection: form.syncDirection,
        mapping,
      })
    }
    dialog.value = false
    ElMessage.success(t('settings.crmSaved'))
    await load()
  } catch (error) {
    handleApiError(error)
  } finally {
    submitting.value = false
  }
}

// ===== 启用 / 停用 / 断开 =====

async function toggleStatus(row: CrmIntegration) {
  const next = row.status === 'connected' ? 'disconnected' : 'connected'
  try {
    await updateCrmIntegration(row.id, { status: next })
    ElMessage.success(next === 'connected' ? t('settings.crmEnabled') : t('settings.crmDisabled'))
    await load()
  } catch (error) {
    handleApiError(error)
  }
}

async function onDisconnect(row: CrmIntegration) {
  const confirmed = await ElMessageBox.confirm(
    t('settings.crmDisconnectConfirm', { provider: providerLabel(row.provider) }),
    {
      type: 'warning',
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
    },
  ).catch(() => false)
  if (!confirmed) return
  try {
    await deleteCrmIntegration(row.id)
    ElMessage.success(t('settings.crmDisconnected'))
    await load()
  } catch (error) {
    handleApiError(error)
  }
}
</script>

<template>
  <div class="crm-integration">
    <el-alert
      class="crm-integration__alert"
      type="info"
      :title="t('settings.crmIntegrationHint')"
      :closable="false"
      show-icon
    />
    <el-alert
      v-if="!isAdmin"
      class="crm-integration__alert"
      type="warning"
      :title="t('settings.adminOnlyHint')"
      :closable="false"
      show-icon
    />

    <div class="crm-integration__toolbar">
      <el-button
        v-permission="['admin']"
        type="primary"
        :disabled="!canAuthorize"
        @click="openCreate"
      >
        {{ t('settings.crmAuthorize') }}
      </el-button>
    </div>

    <el-table v-loading="loading" :data="integrations" stripe>
      <el-table-column :label="t('settings.crmProvider')" min-width="140">
        <template #default="{ row }">
          {{ providerLabel(row.provider) }}
        </template>
      </el-table-column>
      <el-table-column :label="t('settings.crmStatus')" width="110">
        <template #default="{ row }">
          <el-tag
            :type="row.status === 'connected' ? 'success' : 'info'"
            size="small"
            effect="light"
          >
            {{
              row.status === 'connected'
                ? t('settings.crmStatusConnected')
                : t('settings.crmStatusDisconnected')
            }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('settings.crmSyncDirection')" width="130">
        <template #default="{ row }">
          {{ directionLabel(row.syncDirection) }}
        </template>
      </el-table-column>
      <el-table-column :label="t('settings.crmMapping')" width="110">
        <template #default="{ row }">
          {{ t('settings.crmMappingCount', { count: row.mapping?.length ?? 0 }) }}
        </template>
      </el-table-column>
      <el-table-column :label="t('settings.crmLastSyncAt')" min-width="150">
        <template #default="{ row }">{{ formatInOrgTz(row.lastSyncAt) }}</template>
      </el-table-column>
      <el-table-column :label="t('settings.actions')" width="200" fixed="right">
        <template #default="{ row }">
          <el-button
            v-permission="['admin']"
            link
            size="small"
            type="primary"
            @click="openEdit(row)"
          >
            {{ t('settings.crmEdit') }}
          </el-button>
          <el-button v-permission="['admin']" link size="small" @click="toggleStatus(row)">
            {{ row.status === 'connected' ? t('settings.crmDisable') : t('settings.crmEnable') }}
          </el-button>
          <el-button
            v-permission="['admin']"
            link
            size="small"
            type="danger"
            @click="onDisconnect(row)"
          >
            {{ t('settings.crmDisconnect') }}
          </el-button>
        </template>
      </el-table-column>
      <template #empty>
        <EmptyState />
      </template>
    </el-table>

    <el-dialog
      v-model="dialog"
      :title="isEditing ? t('settings.crmEditTitle') : t('settings.crmAuthorize')"
      width="680px"
      destroy-on-close
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
        <el-form-item :label="t('settings.crmProvider')" prop="provider">
          <el-select v-model="form.provider" :disabled="isEditing">
            <el-option
              v-for="provider in providerOptions(isEditing ? form.provider : undefined)"
              :key="provider"
              :value="provider"
              :label="providerLabel(provider)"
            />
          </el-select>
          <span class="crm-integration__hint">{{ t('settings.crmProviderHint') }}</span>
        </el-form-item>

        <el-form-item :label="t('settings.crmSyncDirection')" prop="syncDirection">
          <el-radio-group v-model="form.syncDirection">
            <el-radio-button
              v-for="direction in CRM_SYNC_DIRECTIONS"
              :key="direction"
              :value="direction"
            >
              {{ directionLabel(direction) }}
            </el-radio-button>
          </el-radio-group>
        </el-form-item>

        <el-form-item :label="t('settings.crmMapping')">
          <div class="crm-integration__mapping">
            <div
              v-for="(item, index) in form.mapping"
              :key="index"
              class="crm-integration__mapping-row"
            >
              <el-select v-model="item.local" class="crm-integration__local">
                <el-option
                  v-for="field in availableFields(index)"
                  :key="field"
                  :value="field"
                  :label="fieldLabel(field)"
                />
              </el-select>
              <span class="crm-integration__arrow">→</span>
              <el-input
                v-model="item.remote"
                class="crm-integration__remote"
                :placeholder="t('settings.crmRemoteFieldPlaceholder')"
              />
              <el-button link type="danger" @click="removeMappingRow(index)">
                {{ t('common.delete') }}
              </el-button>
            </div>
            <el-button link type="primary" @click="addMappingRow">
              {{ t('settings.crmAddMappingRow') }}
            </el-button>
            <span class="crm-integration__hint">{{ t('settings.crmMappingHint') }}</span>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">
          {{ t('common.confirm') }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped lang="scss">
.crm-integration {
  &__alert {
    margin-bottom: calc(var(--tp-spacing-base) * 3);
  }

  &__toolbar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: calc(var(--tp-spacing-base) * 3);
  }

  &__hint {
    margin-left: 12px;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__mapping {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
  }

  &__mapping-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  &__local {
    width: 220px;
  }

  &__remote {
    flex: 1;
  }

  &__arrow {
    color: var(--tp-text-tertiary);
  }
}
</style>
