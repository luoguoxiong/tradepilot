<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'

import { fetchMembers, inviteMember, updateMember } from '@/api/resources/org'
import type { Member } from '@/api/types/org'
import EmptyState from '@/components/business/EmptyState.vue'
import { formatInOrgTz } from '@/utils/date'
import { useAuthStore } from '@/stores/auth'
import { useDictStore } from '@/stores/dict'
import { usePermission } from '@/composables/usePermission'

/**
 * 团队成员（16 FR-03，P0）：邀请（invited 态）/ 角色变更 / 停用即时失效。
 * 按角色/状态筛选；仅管理员可管理（16 §3.3 FR-03）。
 */
const { t } = useI18n()
const authStore = useAuthStore()
const dict = useDictStore()
const { isAdmin } = usePermission()

const loading = ref(false)
const members = ref<Member[]>([])
const filterRole = ref<string>('')
const filterStatus = ref<string>('')

const roleOptions = dict.options('memberRole')
const statusOptions = dict.options('memberStatus')

const filtered = computed(() =>
  members.value.filter(
    (m) =>
      (!filterRole.value || m.role === filterRole.value) &&
      (!filterStatus.value || m.status === filterStatus.value),
  ),
)

async function load() {
  loading.value = true
  try {
    members.value = await fetchMembers()
  } finally {
    loading.value = false
  }
}

onMounted(load)

// ===== 邀请成员 =====
const inviteVisible = ref(false)
const inviteRef = ref<FormInstance>()
const inviteSubmitting = ref(false)
const inviteForm = reactive({ email: '', role: 'sales' })

const inviteRules: FormRules = {
  email: [
    { required: true, message: t('auth.emailPlaceholder'), trigger: 'blur' },
    { type: 'email', message: t('auth.emailPlaceholder'), trigger: ['blur', 'change'] },
  ],
  role: [{ required: true, message: t('settings.roleRequired'), trigger: 'change' }],
}

async function submitInvite() {
  const valid = await inviteRef.value?.validate().catch(() => false)
  if (!valid) return
  inviteSubmitting.value = true
  try {
    await inviteMember({ email: inviteForm.email, role: inviteForm.role as Member['role'] })
    ElMessage.success(t('settings.inviteSent'))
    inviteVisible.value = false
    inviteForm.email = ''
    inviteForm.role = 'sales'
    await load()
  } finally {
    inviteSubmitting.value = false
  }
}

// ===== 角色变更 / 停用 / 启用 =====
async function changeRole(member: Member, role: Member['role']) {
  await updateMember(member.memberId, { role })
  member.role = role
  ElMessage.success(t('settings.saved'))
}

/** el-select change 事件值类型较宽，收窄后再提交 */
function onRoleChange(member: Member, role: unknown) {
  if (typeof role !== 'string') return
  void changeRole(member, role as Member['role'])
}

async function toggleStatus(member: Member) {
  const disabling = member.status === 'active'
  if (disabling) {
    await ElMessageBox.confirm(t('settings.disableConfirm', { name: member.name }), {
      type: 'warning',
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
    })
  }
  await updateMember(member.memberId, { status: disabling ? 'disabled' : 'active' })
  member.status = disabling ? 'disabled' : 'active'
  ElMessage.success(t('settings.saved'))
}

function resendInvite(member: Member) {
  // MVP mock：重发即提示（真实链路复用邀请邮件通道）
  ElMessage.success(t('settings.inviteSent'))
  void member
}

function isSelf(member: Member): boolean {
  return member.email === authStore.user?.name || member.role === 'admin'
}

function timeText(member: Member): string {
  const value = member.joinedAt ?? member.invitedAt
  return value ? formatInOrgTz(value, authStore.org?.timezone) : '—'
}
</script>

<template>
  <div v-loading="loading">
    <div class="members__toolbar">
      <el-select
        v-model="filterRole"
        :placeholder="t('settings.filterRole')"
        clearable
        class="members__filter"
      >
        <el-option
          v-for="option in roleOptions"
          :key="option.value"
          :value="option.value"
          :label="t(option.labelKey)"
        />
      </el-select>
      <el-select
        v-model="filterStatus"
        :placeholder="t('settings.filterStatus')"
        clearable
        class="members__filter"
      >
        <el-option
          v-for="option in statusOptions"
          :key="option.value"
          :value="option.value"
          :label="t(option.labelKey)"
        />
      </el-select>
      <el-button v-permission="['admin']" type="primary" @click="inviteVisible = true">
        {{ t('settings.inviteMember') }}
      </el-button>
    </div>

    <el-table :data="filtered" stripe>
      <el-table-column :label="t('settings.memberName')" prop="name" min-width="120" />
      <el-table-column :label="t('auth.email')" prop="email" min-width="200" />
      <el-table-column :label="t('settings.role')" min-width="140">
        <template #default="{ row }">
          <el-select
            v-if="row.role !== 'admin' && isAdmin"
            :model-value="row.role"
            size="small"
            @change="onRoleChange(row, $event)"
          >
            <el-option
              v-for="option in roleOptions"
              :key="option.value"
              :value="option.value"
              :label="t(option.labelKey)"
            />
          </el-select>
          <el-tag v-else size="small" effect="plain">{{
            dict.label('memberRole', row.role)
          }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('settings.status')" min-width="110">
        <template #default="{ row }">
          <span class="members__status" :style="{ color: dict.color('memberStatus', row.status) }">
            {{ dict.label('memberStatus', row.status) }}
          </span>
        </template>
      </el-table-column>
      <el-table-column :label="t('settings.memberTime')" min-width="150">
        <template #default="{ row }">{{ timeText(row) }}</template>
      </el-table-column>
      <el-table-column :label="t('settings.actions')" width="140" fixed="right">
        <template #default="{ row }">
          <template v-if="isAdmin && !isSelf(row)">
            <el-button v-if="row.status === 'invited'" link size="small" @click="resendInvite(row)">
              {{ t('settings.resendInvite') }}
            </el-button>
            <el-button
              v-if="row.status === 'active'"
              link
              size="small"
              type="danger"
              @click="toggleStatus(row)"
            >
              {{ t('settings.disable') }}
            </el-button>
            <el-button
              v-if="row.status === 'disabled'"
              link
              size="small"
              @click="toggleStatus(row)"
            >
              {{ t('settings.enable') }}
            </el-button>
          </template>
          <span v-else>—</span>
        </template>
      </el-table-column>
      <template #empty>
        <EmptyState />
      </template>
    </el-table>

    <el-dialog v-model="inviteVisible" :title="t('settings.inviteMember')" width="440px">
      <el-form
        ref="inviteRef"
        :model="inviteForm"
        :rules="inviteRules"
        label-width="80px"
        @submit.prevent
      >
        <el-form-item :label="t('auth.email')" prop="email">
          <el-input v-model="inviteForm.email" :placeholder="t('auth.emailPlaceholder')" />
        </el-form-item>
        <el-form-item :label="t('settings.role')" prop="role">
          <el-radio-group v-model="inviteForm.role">
            <el-radio v-for="option in roleOptions" :key="option.value" :value="option.value">
              {{ t(option.labelKey) }}
            </el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="inviteVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="inviteSubmitting" @click="submitInvite">
          {{ t('settings.inviteAndCopyLink') }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped lang="scss">
.members {
  &__toolbar {
    display: flex;
    justify-content: flex-end;
    gap: calc(var(--tp-spacing-base) * 2);
    margin-bottom: calc(var(--tp-spacing-base) * 3);
  }

  &__filter {
    width: 140px;
  }

  &__status {
    font-weight: 500;
  }
}
</style>
