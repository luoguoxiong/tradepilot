<script setup lang="ts">
import { useI18n } from 'vue-i18n'

import type { ContactItem } from '@/api/types/customers'

/**
 * ContactDetailDrawer 联系人详情侧滑抽屉（04 FR-06 / §1.4）：
 * 完整信息 + 决策影响力证据链（规则基线 / AI 精化，§3.2 Tooltip 展示）。
 */
withDefaults(
  defineProps<{
    modelValue: boolean
    contact?: ContactItem | null
    loading?: boolean
  }>(),
  { contact: null, loading: false },
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const { t } = useI18n()

function close() {
  emit('update:modelValue', false)
}

const influenceText = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : `${value}%`
</script>

<template>
  <el-drawer
    :model-value="modelValue"
    :title="t('c360.contactDetail')"
    size="420px"
    append-to-body
    @update:model-value="close"
  >
    <div v-loading="loading" class="contact-detail">
      <template v-if="contact">
        <div class="contact-detail__name">
          {{ contact.name }}
          <el-tag v-if="contact.isPrimary" size="small" type="success" effect="plain">
            {{ t('crm.primary') }}
          </el-tag>
        </div>
        <p class="contact-detail__title">{{ contact.title || '—' }}</p>
        <p class="contact-detail__email">{{ contact.email || '—' }}</p>

        <el-divider />

        <dl class="contact-detail__fields">
          <div class="contact-detail__row">
            <dt>{{ t('crm.decisionInfluence') }}</dt>
            <dd>
              <div class="contact-detail__influence">
                <el-tooltip placement="top" :disabled="!contact.decisionInfluenceReasons?.length">
                  <template #content>
                    <div v-if="contact.decisionInfluenceReasons?.length">
                      <p
                        v-for="(r, i) in contact.decisionInfluenceReasons"
                        :key="i"
                        class="contact-detail__reason"
                      >
                        {{ r.text }}
                        <span v-if="r.evidence" class="contact-detail__reason-meta">
                          {{ r.evidence }}
                        </span>
                      </p>
                    </div>
                  </template>
                  <span class="contact-detail__influence-num">{{
                    influenceText(contact.decisionInfluencePct)
                  }}</span>
                </el-tooltip>
              </div>
            </dd>
          </div>
          <div class="contact-detail__row">
            <dt>{{ t('crm.company') }}</dt>
            <dd>{{ contact.companyName || '—' }}</dd>
          </div>
        </dl>
      </template>
      <el-empty v-else-if="!loading" :description="t('common.empty')" />
    </div>
  </el-drawer>
</template>

<style scoped lang="scss">
.contact-detail {
  min-height: 120px;

  &__name {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 16px;
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__title {
    margin: 6px 0 2px;
    color: var(--tp-text-secondary);
  }

  &__email {
    margin: 0;
    color: var(--tp-text-tertiary);
  }

  &__fields {
    margin: 0;
  }

  &__row {
    display: flex;
    gap: 16px;
    padding: 8px 0;

    dt {
      flex-shrink: 0;
      width: 96px;
      color: var(--tp-text-tertiary);
    }

    dd {
      margin: 0;
      color: var(--tp-text-primary);
      word-break: break-word;
    }
  }

  &__reason {
    margin: 0 0 6px;
    line-height: 1.5;
  }

  &__reason-meta {
    display: block;
    color: var(--tp-text-tertiary);
  }
}
</style>
