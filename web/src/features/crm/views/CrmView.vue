<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { ElMessage, ElMessageBox } from 'element-plus'

import ProTable from '@/components/business/ProTable.vue'
import type { ProColumn } from '@/components/business/pro-table'
import type { FilterField } from '@/components/business/FilterBar.vue'
import ContactDetailDrawer from '@/components/business/ContactDetailDrawer.vue'
import OutreachDraftDialog from '@/components/business/OutreachDraftDialog.vue'
import CustomerListTable from '@/features/crm/components/CustomerListTable.vue'
import CustomerFormDialog, {
  type OwnerOption,
} from '@/features/crm/components/CustomerFormDialog.vue'
import ContactFormDrawer from '@/features/crm/components/ContactFormDrawer.vue'
import { fetchMembers } from '@/api/resources/org'
import { deleteContact, getActivities, getContacts } from '@/api/resources/customers'
import type {
  ActivityListReq,
  ContactItem,
  ContactListReq,
  CustomerItem,
} from '@/api/types/customers'
import type { ApiError } from '@/api/http'
import { qk } from '@/query/keys'
import { staleTime } from '@/query/options'
import { useAuthStore } from '@/stores/auth'
import { useOutreachDraft } from '@/features/customer360/composables/useOutreachDraft'
import { formatInOrgTz } from '@/utils/date'

type CrmTab = 'potential' | 'formal' | 'contacts' | 'activities'

defineOptions({ name: 'CrmView' })

/**
 * 05 CRM 客户中心主视图（四页签）：
 * - 潜在/正式客户页签：复用 CustomerListTable（批量改派/删除乐观更新 + AI 建议列）；
 * - 联系人页签：列表 + 单条删除（05 §3.5：不走审批、不写客户活动）；
 * - 全部活动页签：只读全局时间线（同客户 360° 数据口径）。
 * 添加/编辑客户共用 CustomerFormDialog（05 §1.2 / §4 负责人规则）。
 */
const { t } = useI18n()
const route = useRoute()
const queryClient = useQueryClient()
const auth = useAuthStore()

const timezone = computed(() => auth.org?.timezone)

// ===== 四页签 =====
// /crm 与 /crm/contacts 为不同路由（keep-alive key 按 path 隔离为独立实例，02 §6），
// 初始页签由 route.path 决定即可；无需 watch path —— keep-alive 返回时保留内部页签态。
const isCustomerTab = (tab: CrmTab) => tab === 'potential' || tab === 'formal'
const activeTab = ref<CrmTab>(route.path.endsWith('/crm/contacts') ? 'contacts' : 'potential')

// ===== owner 候选（当前用户 + 团队活跃成员，05 §4） =====
const membersQuery = useQuery({
  queryKey: qk.orgMembers,
  queryFn: fetchMembers,
  staleTime: staleTime.DICT,
})

const ownerOptions = computed<OwnerOption[]>(() => {
  const options: OwnerOption[] = []
  const seen = new Set<string>()
  if (auth.user?.userId) {
    options.push({ value: auth.user.userId, label: auth.user.name })
    seen.add(auth.user.userId)
  }
  for (const member of membersQuery.data.value ?? []) {
    if (member.status !== 'active' || seen.has(member.memberId)) continue
    options.push({ value: member.memberId, label: member.name })
    seen.add(member.memberId)
  }
  return options
})

// ===== 添加 / 编辑客户表单 =====
const formVisible = ref(false)
const formMode = ref<'create' | 'edit'>('create')
const editingCustomer = ref<CustomerItem | null>(null)

function openCreate() {
  formMode.value = 'create'
  editingCustomer.value = null
  formVisible.value = true
}

function openEdit(customer: CustomerItem) {
  formMode.value = 'edit'
  editingCustomer.value = customer
  formVisible.value = true
}

function onSaved() {
  void queryClient.invalidateQueries({ queryKey: qk.customers.all })
}

// ===== 联系人页签 =====
const contactColumns: ProColumn[] = [
  { prop: 'name', labelKey: 'crm.contactName', minWidth: 150, fixed: 'left' },
  { prop: 'companyName', labelKey: 'crm.company', minWidth: 180 },
  { prop: 'title', labelKey: 'crm.contactTitle', minWidth: 140 },
  { prop: 'email', labelKey: 'crm.contactEmail', minWidth: 200 },
  { prop: 'decisionInfluencePct', labelKey: 'crm.decisionInfluence', minWidth: 130 },
  { prop: 'actions', labelKey: 'settings.actions', width: 210, fixed: 'right' },
]

const fetchContacts = (params: Record<string, unknown>) => getContacts(params as ContactListReq)

// 新增 / 编辑联系人表单（编辑走 Drawer，02 §4.3）
const contactFormVisible = ref(false)
const contactFormMode = ref<'create' | 'edit'>('create')
const editingContact = ref<ContactItem | null>(null)

function openCreateContact() {
  contactFormMode.value = 'create'
  editingContact.value = null
  contactFormVisible.value = true
}

function openEditContact(contact: ContactItem) {
  contactFormMode.value = 'edit'
  editingContact.value = contact
  contactFormVisible.value = true
}

function onContactSaved() {
  void queryClient.invalidateQueries({ queryKey: qk.contacts.all })
}

// 详情抽屉 + AI 开发信草稿（复用 04 组件）
const contactDetailVisible = ref(false)
const selectedContact = ref<ContactItem | null>(null)
const outreach = useOutreachDraft()

function openContactDetail(contact: ContactItem) {
  selectedContact.value = contact
  contactDetailVisible.value = true
}

const deleteContactMutation = useMutation({
  mutationFn: (contact: ContactItem) => deleteContact(contact.contactId),
  onError: (error: ApiError) => {
    ElMessage.error(error.message || t('common.operationFailed'))
  },
  onSuccess: () => {
    ElMessage.success(t('crm.contactDeleted'))
  },
  onSettled: () => {
    void queryClient.invalidateQueries({ queryKey: qk.contacts.all })
  },
})

async function confirmDeleteContact(contact: ContactItem) {
  try {
    await ElMessageBox.confirm(t('crm.deleteContactConfirm', { name: contact.name }), {
      type: 'warning',
      confirmButtonText: t('common.delete'),
      cancelButtonText: t('common.cancel'),
    })
  } catch {
    return
  }
  deleteContactMutation.mutate(contact)
}

// ===== 全部活动页签（只读时间线） =====
const activityFilters: FilterField[] = [
  { prop: 'type', labelKey: 'crm.activityType', type: 'select', enumGroup: 'activityType' },
]

const activityColumns: ProColumn[] = [
  { prop: 'type', labelKey: 'crm.activityType', width: 110, enumGroup: 'activityType' },
  { prop: 'summary', labelKey: 'crm.activitySummary', minWidth: 320 },
  { prop: 'customerName', labelKey: 'crm.company', minWidth: 160 },
  { prop: 'operatorType', labelKey: 'crm.operator', minWidth: 130 },
  { prop: 'createdAt', labelKey: 'crm.activityTime', width: 160 },
]

const fetchActivities = (params: Record<string, unknown>) =>
  getActivities(params as ActivityListReq)
</script>

<template>
  <div class="crm">
    <div class="crm__toolbar">
      <el-tabs v-model="activeTab" class="crm__tabs">
        <el-tab-pane lazy name="potential">
          <template #label>{{ t('crm.tabPotential') }}</template>
          <CustomerListTable tab="potential" :owner-options="ownerOptions" @edit="openEdit" />
        </el-tab-pane>
        <el-tab-pane lazy name="formal">
          <template #label>{{ t('crm.tabFormal') }}</template>
          <CustomerListTable tab="formal" :owner-options="ownerOptions" @edit="openEdit" />
        </el-tab-pane>
        <el-tab-pane lazy name="contacts">
          <template #label>{{ t('crm.tabContacts') }}</template>
          <ProTable
            :columns="contactColumns"
            :fetcher="fetchContacts"
            :query-key-base="qk.contacts.all"
            row-key="contactId"
            :page-size="20"
          >
            <template #col-name="{ row }">
              <span class="crm__contact-name">
                <el-link type="primary" :underline="false" @click="openContactDetail(row)">
                  {{ row.name }}
                </el-link>
                <el-tag v-if="row.isPrimary" size="small" type="success" effect="plain">
                  {{ t('crm.primary') }}
                </el-tag>
              </span>
            </template>
            <template #col-decisionInfluencePct="{ row }">
              <span>{{
                row.decisionInfluencePct !== null && row.decisionInfluencePct !== undefined
                  ? `${row.decisionInfluencePct}%`
                  : '—'
              }}</span>
            </template>
            <template #col-actions="{ row }">
              <el-button link type="primary" size="small" @click="openContactDetail(row)">
                {{ t('crm.viewDetail') }}
              </el-button>
              <el-button link type="primary" size="small" @click="openEditContact(row)">
                {{ t('crm.edit') }}
              </el-button>
              <el-button
                link
                size="small"
                :loading="outreach.loading.value"
                @click="outreach.generate(row.contactId, 'cold_outreach')"
              >
                {{ t('crm.contactOutreach') }}
              </el-button>
              <el-button
                link
                type="danger"
                size="small"
                :disabled="deleteContactMutation.isPending.value"
                @click="confirmDeleteContact(row)"
              >
                {{ t('crm.deleteContact') }}
              </el-button>
            </template>
          </ProTable>
        </el-tab-pane>
        <el-tab-pane lazy name="activities">
          <template #label>{{ t('crm.tabActivities') }}</template>
          <ProTable
            :columns="activityColumns"
            :filters="activityFilters"
            :fetcher="fetchActivities"
            :query-key-base="qk.activities.all"
            row-key="activityId"
            :page-size="20"
          >
            <!-- 操作方：AI / 人工（05 §1.3 口径） -->
            <template #col-operatorType="{ row }">
              <el-tag
                :type="row.operatorType === 'ai' ? 'primary' : 'info'"
                size="small"
                effect="plain"
              >
                {{ row.operatorType === 'ai' ? t('crm.operatorAi') : t('crm.operatorUser') }} ·
                {{ row.operatorName }}
              </el-tag>
            </template>
            <template #col-createdAt="{ row }">
              <span>{{ formatInOrgTz(row.createdAt, timezone) }}</span>
            </template>
          </ProTable>
        </el-tab-pane>
      </el-tabs>

      <el-button
        v-if="isCustomerTab(activeTab)"
        type="primary"
        class="crm__add"
        @click="openCreate"
      >
        {{ t('crm.addCustomer') }}
      </el-button>
      <el-button
        v-else-if="activeTab === 'contacts'"
        type="primary"
        class="crm__add"
        @click="openCreateContact"
      >
        {{ t('crm.addContactButton') }}
      </el-button>
    </div>

    <CustomerFormDialog
      v-model="formVisible"
      :mode="formMode"
      :customer="editingCustomer"
      :owner-options="ownerOptions"
      @saved="onSaved"
    />

    <ContactFormDrawer
      v-model="contactFormVisible"
      :mode="contactFormMode"
      :contact="editingContact"
      @saved="onContactSaved"
    />

    <ContactDetailDrawer v-model="contactDetailVisible" :contact="selectedContact" />

    <OutreachDraftDialog
      v-model="outreach.visible.value"
      :loading="outreach.loading.value"
      :draft="outreach.draft.value"
      @regenerate="outreach.regenerate"
      @update:model-value="outreach.close"
    />
  </div>
</template>

<style scoped lang="scss">
.crm {
  &__toolbar {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  &__tabs {
    flex: 1;
  }

  &__add {
    flex-shrink: 0;
    margin-top: 2px;
  }

  &__contact-name {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
}
</style>
