<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'

import ContactDetailDrawer from '@/components/business/ContactDetailDrawer.vue'
import EmptyState from '@/components/business/EmptyState.vue'
import OutreachDraftDialog from '@/components/business/OutreachDraftDialog.vue'
import { getCustomerContacts } from '@/api/resources/customers'
import type { ContactItem } from '@/api/types/customers'
import { qk } from '@/query/keys'
import { listQueryOptions } from '@/query/options'
import { useOutreachDraft } from '@/features/customer360/composables/useOutreachDraft'

/**
 * ContactsPanel Contacts 页签（04 §1.4 / FR-06）：
 * 联系人卡片 + 决策影响力进度条（规则基线；AI 精化证据链 Tooltip）；
 * 操作：查看详情（侧滑抽屉）/ AI 生成开发信（产出草稿预览，04 §3.4）。
 */
const props = defineProps<{ entityId: string }>()

const { t } = useI18n()

const page = ref(1)
const pageSize = 20

const filters = computed(() => ({ page: page.value, pageSize }))

const contactsQuery = useQuery({
  queryKey: computed(() => qk.customer360.contacts(props.entityId, filters.value)),
  queryFn: () => getCustomerContacts(props.entityId, filters.value),
  ...listQueryOptions(),
})

watch(
  () => props.entityId,
  () => {
    page.value = 1
  },
)

// ===== 抽屉 / 开发信草稿 =====
const drawerVisible = ref(false)
const selected = ref<ContactItem | null>(null)
const outreach = useOutreachDraft()

function openDetail(contact: ContactItem) {
  selected.value = contact
  drawerVisible.value = true
}

const total = computed(() => contactsQuery.data.value?.total ?? 0)
const list = computed(() => contactsQuery.data.value?.list ?? [])

function influenceBarWidth(pct?: number | null): string {
  if (pct === null || pct === undefined) return '0%'
  return `${Math.max(0, Math.min(100, pct))}%`
}
</script>

<template>
  <div class="contacts-panel">
    <el-skeleton v-if="contactsQuery.isLoading.value" :rows="5" animated />

    <template v-else>
      <div v-if="list.length" class="contacts-panel__cards">
        <div v-for="contact in list" :key="contact.contactId" class="contacts-panel__card">
          <el-avatar :size="40" class="contacts-panel__avatar">
            {{ contact.name.charAt(0).toUpperCase() }}
          </el-avatar>

          <div class="contacts-panel__main">
            <div class="contacts-panel__line1">
              <span class="contacts-panel__name">{{ contact.name }}</span>
              <el-tag v-if="contact.isPrimary" size="small" type="success" effect="plain">
                {{ t('crm.primary') }}
              </el-tag>
            </div>
            <p class="contacts-panel__title">{{ contact.title || '—' }}</p>
            <p class="contacts-panel__email">{{ contact.email || '—' }}</p>

            <div class="contacts-panel__influence">
              <el-tooltip placement="top" :disabled="!contact.decisionInfluenceReasons?.length">
                <template #content>
                  <div v-if="contact.decisionInfluenceReasons?.length">
                    <p
                      v-for="(r, i) in contact.decisionInfluenceReasons"
                      :key="i"
                      class="contacts-panel__reason"
                    >
                      {{ r.text }}
                      <span v-if="r.evidence" class="contacts-panel__reason-meta">
                        {{ r.evidence }}
                      </span>
                    </p>
                  </div>
                </template>
                <span class="contacts-panel__influence-label">
                  {{ t('crm.decisionInfluence') }}
                </span>
                <div class="contacts-panel__bar">
                  <div
                    v-if="
                      contact.decisionInfluencePct !== null &&
                      contact.decisionInfluencePct !== undefined
                    "
                    class="contacts-panel__bar-fill"
                    :style="{ width: influenceBarWidth(contact.decisionInfluencePct) }"
                  />
                </div>
                <span class="contacts-panel__influence-num">
                  {{
                    contact.decisionInfluencePct === null ||
                    contact.decisionInfluencePct === undefined
                      ? '—'
                      : `${contact.decisionInfluencePct}%`
                  }}
                </span>
              </el-tooltip>
            </div>
          </div>

          <div class="contacts-panel__actions">
            <el-button link type="primary" size="small" @click="openDetail(contact)">
              {{ t('c360.contactViewDetail') }}
            </el-button>
            <el-button
              link
              size="small"
              :loading="outreach.loading.value"
              @click="outreach.generate(contact.contactId, 'cold_outreach')"
            >
              {{ t('c360.contactOutreach') }}
            </el-button>
          </div>
        </div>
      </div>

      <div v-else class="contacts-panel__empty">
        <EmptyState :title="t('c360.contactsEmpty')" />
      </div>

      <el-pagination
        v-if="total > pageSize"
        class="contacts-panel__pager"
        layout="prev, pager, next"
        :total="total"
        :page-size="pageSize"
        :current-page="page"
        @current-change="page = $event"
      />
    </template>

    <ContactDetailDrawer v-model="drawerVisible" :contact="selected" />
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
.contacts-panel {
  &__cards {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  &__card {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 14px;
    border: 1px solid var(--tp-border-color);
    border-radius: 8px;
    background: var(--tp-bg-card, #fff);

    &:hover {
      border-color: var(--tp-primary);
    }
  }

  &__avatar {
    flex-shrink: 0;
    background: color-mix(in srgb, var(--tp-primary) 15%, transparent);
    color: var(--tp-primary);
    font-weight: 600;
  }

  &__main {
    flex: 1;
    min-width: 0;
  }

  &__line1 {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  &__name {
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__title,
  &__email {
    margin: 3px 0;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__influence {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
  }

  &__influence-label {
    flex-shrink: 0;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__bar {
    flex: 1;
    height: 6px;
    border-radius: 3px;
    background: var(--tp-bg-hover);
    overflow: hidden;
  }

  &__bar-fill {
    height: 100%;
    border-radius: 3px;
    background: linear-gradient(90deg, var(--ai-waiting), var(--ai-working));
  }

  &__influence-num {
    flex-shrink: 0;
    min-width: 34px;
    text-align: right;
    font-size: 12px;
    font-weight: 600;
    color: var(--tp-text-secondary);
  }

  &__actions {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
  }

  &__reason {
    margin: 0 0 6px;
    line-height: 1.5;
  }

  &__reason-meta {
    display: block;
    color: var(--tp-text-tertiary);
  }

  &__pager {
    margin-top: 14px;
    justify-content: flex-end;
  }

  &__empty {
    padding: 24px 0;
  }
}
</style>
