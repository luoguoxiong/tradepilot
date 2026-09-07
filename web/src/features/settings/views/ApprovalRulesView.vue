<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'

import type { Role } from '@/api/types/common'
import { fetchRolePermissions, updateRolePermissions } from '@/api/resources/settings'
import type { ApprovalRule, RolePermissions } from '@/api/types/settings'
import { AUTO_APPROVABLE_TYPES, MANDATORY_APPROVAL_TYPES } from '@/api/types/settings'
import EmptyState from '@/components/business/EmptyState.vue'
import { useDictStore } from '@/stores/dict'
import { usePermission } from '@/composables/usePermission'
import { useFormLeaveGuard } from '@/composables/useFormLeaveGuard'

/**
 * 权限与审批规则（16 FR-08，P0）：
 * - 三角色权限矩阵（只读展示，基线见 05 §3.2）
 * - 审批规则：6 类强制绑定类型不可绕过；medium 类型可开 autoApprove；
 *   Break-up Email 强制人工审（07 §4）为只读说明。
 * 员工级 approval_policy 覆盖随 02 员工详情（M3）交付。
 */
const { t } = useI18n()
const dict = useDictStore()
const { isAdmin } = usePermission()

const loading = ref(false)
const saving = ref(false)
const rolePermissions = ref<RolePermissions[]>([])
/** 审批规则为 org 级语义，读写走 admin 角色（mock 契约，后端就绪后按实际归属调整） */
const rules = ref<ApprovalRule[]>([])

const ROLES: Role[] = ['admin', 'manager', 'sales']
const MATRIX_TYPES = AUTO_APPROVABLE_TYPES
const MANDATORY = MANDATORY_APPROVAL_TYPES
const roleOptions = dict.options('memberRole')

// 02 §6 表单离开拦截：加载完成后规则/矩阵变更即置脏，保存成功复位
const loaded = ref(false)
const dirty = ref(false)
watch(
  [rules, rolePermissions],
  () => {
    if (loaded.value && !saving.value) dirty.value = true
  },
  { deep: true },
)
useFormLeaveGuard({ isDirty: () => dirty.value })

onMounted(load)

async function load() {
  loading.value = true
  try {
    rolePermissions.value = await Promise.all(ROLES.map((role) => fetchRolePermissions(role)))
    rules.value = rolePermissions.value.find((p) => p.role === 'admin')?.approvalRules ?? []
    loaded.value = true
  } finally {
    loading.value = false
  }
}

function isMandatory(type: string): boolean {
  return (MANDATORY as readonly string[]).includes(type)
}

/** 模板 helper：审批类型列表 → 本地化文案（表格插槽 row 为 any，收窄进 script） */
function approvalTypesLabel(approvals: string[]): string {
  return approvals.map((type) => t(`enums.approvalTab.${type}`)).join(' / ')
}

/** 模板 helper：审批人角色列表 → 本地化文案 */
function rolesLabel(roles: string[]): string {
  return roles.map((role) => dict.label('memberRole', role)).join(' / ') || '—'
}

function canAutoApprove(type: string): boolean {
  return (MATRIX_TYPES as readonly string[]).includes(type)
}

function onRolesChange(rule: ApprovalRule, roles: unknown) {
  if (Array.isArray(roles)) rule.approverRoles = roles as Role[]
}

async function save() {
  // 强制绑定校验（16 接口文档 §3.6：置空 → 42201）
  const invalid = rules.value.find(
    (rule) => isMandatory(rule.approvalType) && rule.approverRoles.length === 0,
  )
  if (invalid) {
    ElMessage.error(
      t('settings.mandatoryRuleError', { type: t(`enums.approvalTab.${invalid.approvalType}`) }),
    )
    return
  }
  saving.value = true
  try {
    const admin = rolePermissions.value.find((p) => p.role === 'admin')
    if (!admin) return
    admin.approvalRules = rules.value.map((rule) => ({
      ...rule,
      // high 风险类型（quote/contract/customer_delete）不允许自动通过（12 §7.1）
      autoApprove: canAutoApprove(rule.approvalType) ? rule.autoApprove : false,
    }))
    await updateRolePermissions('admin', admin)
    dirty.value = false
    ElMessage.success(t('settings.saved'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-loading="loading">
    <h3 class="approval-rules__section">{{ t('settings.permissionMatrix') }}</h3>
    <el-table :data="rolePermissions" stripe class="approval-rules__matrix">
      <el-table-column :label="t('settings.role')" min-width="100">
        <template #default="{ row }">{{ dict.label('memberRole', row.role) }}</template>
      </el-table-column>
      <el-table-column :label="t('settings.matrixCustomers')" min-width="110">
        <template #default="{ row }">
          <el-tag size="small" effect="plain">{{
            t(`enums.scope.${row.permissions.customers}`)
          }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('settings.matrixQuotes')" min-width="110">
        <template #default="{ row }">{{ row.permissions.quotes }}</template>
      </el-table-column>
      <el-table-column :label="t('settings.matrixApprovals')" min-width="180">
        <template #default="{ row }">
          <span v-if="row.permissions.approvals.length">
            {{ approvalTypesLabel(row.permissions.approvals) }}
          </span>
          <span v-else>—</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('settings.matrixSettings')" min-width="90">
        <template #default="{ row }">{{ row.permissions.settings }}</template>
      </el-table-column>
      <template #empty>
        <EmptyState />
      </template>
    </el-table>

    <h3 class="approval-rules__section">{{ t('settings.approvalRules') }}</h3>
    <el-alert
      class="approval-rules__notice"
      :title="t('settings.breakupNotice')"
      type="info"
      :closable="false"
      show-icon
    />
    <el-table :data="rules" stripe>
      <el-table-column :label="t('settings.approvalType')" min-width="160">
        <template #default="{ row }">
          {{ t(`enums.approvalTab.${row.approvalType}`) }}
          <el-tooltip v-if="isMandatory(row.approvalType)" :content="t('settings.mandatoryTip')">
            <el-icon class="approval-rules__lock"><Lock /></el-icon>
          </el-tooltip>
        </template>
      </el-table-column>
      <el-table-column :label="t('settings.approverRoles')" min-width="220">
        <template #default="{ row }">
          <el-select
            v-if="isAdmin"
            :model-value="row.approverRoles"
            multiple
            :disabled="isMandatory(row.approvalType) && row.approvalType !== 'email_send'"
            :placeholder="t('settings.approverRoles')"
            @update:model-value="onRolesChange(row, $event)"
          >
            <el-option
              v-for="option in roleOptions"
              :key="option.value"
              :value="option.value"
              :label="t(option.labelKey)"
            />
          </el-select>
          <span v-else>{{ rolesLabel(row.approverRoles) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('settings.autoApprove')" min-width="140">
        <template #default="{ row }">
          <el-switch
            v-if="canAutoApprove(row.approvalType)"
            v-model="row.autoApprove"
            :disabled="!isAdmin"
          />
          <el-tooltip v-else :content="t('settings.autoApproveForbidden')">
            <el-tag size="small" type="info" effect="plain">{{ t('settings.highRisk') }}</el-tag>
          </el-tooltip>
        </template>
      </el-table-column>
      <template #empty>
        <EmptyState />
      </template>
    </el-table>

    <div v-if="isAdmin" class="approval-rules__footer">
      <el-button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</el-button>
    </div>
  </div>
</template>

<style scoped lang="scss">
.approval-rules {
  &__section {
    margin: calc(var(--tp-spacing-base) * 5) 0 calc(var(--tp-spacing-base) * 3);
    font-size: 14px;
    font-weight: 600;

    &:first-of-type {
      margin-top: 0;
    }
  }

  &__notice {
    margin-bottom: calc(var(--tp-spacing-base) * 3);
  }

  &__lock {
    vertical-align: -2px;
    color: var(--tp-text-tertiary);
  }

  &__footer {
    margin-top: calc(var(--tp-spacing-base) * 5);
  }
}
</style>
