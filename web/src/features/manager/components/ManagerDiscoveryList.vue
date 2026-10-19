<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

import EmptyState from '@/components/business/EmptyState.vue'
import type { ManagerDiscovery, ManagerDiscoveryType } from '@/api/types/manager'
import { MANAGER_DISCOVERY_TYPES } from '@/api/types/manager'
import { useAuthStore } from '@/stores/auth'
import { useDictStore } from '@/stores/dict'
import { formatInOrgTz } from '@/utils/date'

/**
 * 13 §1.2 AI 发现列表：
 * - 类型 Tab（全部 / 机会 / 风险）走 `type` 查询参数（服务端过滤）；
 * - 每条发现展示 标题 + 说明 + 判断依据（evidence，ref 可跳数据中心明细）+ 一键动作；
 * - 已执行发现保留在列表并折叠为「已执行」+ 产物入口（任务 / 策略），不重复执行。
 */
const props = withDefaults(
  defineProps<{
    items: ManagerDiscovery[]
    type: ManagerDiscoveryType
    loading?: boolean
    executingId?: string | null
  }>(),
  { loading: false, executingId: null },
)

const emit = defineEmits<{
  'update:type': [value: ManagerDiscoveryType]
  execute: [discovery: ManagerDiscovery]
}>()

const { t } = useI18n()
const router = useRouter()
const dict = useDictStore()
const auth = useAuthStore()

/** evidence.ref 指向数据中心/业务明细，点击即跳转 */
function openRef(ref: string | undefined) {
  if (ref) void router.push(ref)
}

function executedAt(item: ManagerDiscovery): string {
  return item.executedAt
    ? formatInOrgTz(item.executedAt, auth.org?.timezone, 'YYYY-MM-DD HH:mm')
    : ''
}

function taskIdOf(item: ManagerDiscovery): string | null {
  const value = item.executedRef?.['taskId']
  return typeof value === 'string' ? value : null
}

function strategyIdOf(item: ManagerDiscovery): string | null {
  const value = item.executedRef?.['strategyId']
  return typeof value === 'string' ? value : null
}
</script>

<template>
  <el-card shadow="never" class="manager-discovery">
    <template #header>
      <div class="manager-discovery__header">
        <span class="manager-discovery__title">{{ t('manager.discovery.title') }}</span>
        <el-radio-group
          :model-value="props.type"
          size="small"
          @update:model-value="emit('update:type', $event as ManagerDiscoveryType)"
        >
          <el-radio-button v-for="tab in MANAGER_DISCOVERY_TYPES" :key="tab" :value="tab">
            {{ t(`manager.discovery.${tab}`) }}
          </el-radio-button>
        </el-radio-group>
      </div>
    </template>

    <el-skeleton v-if="props.loading" :rows="5" animated />

    <EmptyState v-else-if="props.items.length === 0" :title="t('manager.discovery.empty')" />

    <ul v-else class="manager-discovery__list">
      <li
        v-for="item in props.items"
        :key="item.discoveryId"
        class="manager-discovery__item"
        data-testid="manager-discovery-item"
      >
        <div class="manager-discovery__item-head">
          <el-tag
            size="small"
            effect="light"
            :type="item.type === 'risk' ? 'danger' : 'success'"
            :style="{ color: dict.color('managerDiscoveryType', item.type) }"
          >
            {{ dict.label('managerDiscoveryType', item.type) }}
          </el-tag>
          <span class="manager-discovery__item-title">{{ item.title }}</span>
          <el-tag v-if="item.status === 'executed'" size="small" type="info" effect="plain">
            {{ t('manager.discovery.executed') }}
          </el-tag>
        </div>

        <p class="manager-discovery__detail">{{ item.detail }}</p>

        <div v-if="item.evidence.length" class="manager-discovery__evidence">
          <span class="manager-discovery__evidence-label">{{
            t('manager.discovery.evidence')
          }}</span>
          <ul class="manager-discovery__evidence-list">
            <li
              v-for="(evidence, index) in item.evidence"
              :key="`${item.discoveryId}-${index}`"
              class="manager-discovery__evidence-item"
            >
              <span class="manager-discovery__evidence-text">{{ evidence.text }}</span>
              <span v-if="evidence.source" class="manager-discovery__evidence-source">
                {{ t('manager.discovery.evidenceSource') }}：{{ evidence.source }}
              </span>
              <el-button
                v-if="evidence.ref"
                link
                type="primary"
                size="small"
                @click="openRef(evidence.ref)"
              >
                {{ t('manager.discovery.viewDetail') }}
              </el-button>
            </li>
          </ul>
        </div>

        <div class="manager-discovery__foot">
          <span class="manager-discovery__suggestion">{{ item.suggestion.label }}</span>
          <div class="manager-discovery__actions">
            <template v-if="item.status === 'executed'">
              <span class="manager-discovery__executed-at">
                {{ t('manager.discovery.executedAt') }} {{ executedAt(item) }}
              </span>
              <el-button
                v-if="taskIdOf(item)"
                link
                type="primary"
                size="small"
                @click="router.push(`/tasks/${taskIdOf(item)}`)"
              >
                {{ t('manager.discovery.viewTask') }}
              </el-button>
              <el-button
                v-if="strategyIdOf(item)"
                link
                type="primary"
                size="small"
                @click="router.push('/follow-up/strategies')"
              >
                {{ t('manager.discovery.viewStrategy') }}
              </el-button>
            </template>
            <el-button
              v-else
              type="primary"
              size="small"
              :loading="props.executingId === item.discoveryId"
              @click="emit('execute', item)"
            >
              {{ item.actions }}
            </el-button>
          </div>
        </div>
      </li>
    </ul>
  </el-card>
</template>

<style scoped lang="scss">
.manager-discovery {
  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  &__title {
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__list {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  &__item {
    padding: 12px 0;
    border-bottom: 1px solid var(--tp-border-color);

    &:last-child {
      border-bottom: none;
      padding-bottom: 0;
    }
  }

  &__item-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  &__item-title {
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__detail {
    margin: 6px 0 0;
    font-size: 13px;
    line-height: 1.6;
    color: var(--tp-text-secondary);
    overflow-wrap: anywhere;
  }

  &__evidence {
    margin-top: 8px;
    padding: 8px 10px;
    background: var(--tp-bg-hover);
    border-radius: 6px;
  }

  &__evidence-label {
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__evidence-list {
    margin: 4px 0 0;
    padding: 0;
    list-style: none;
  }

  &__evidence-item {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 12px;
    line-height: 1.8;
    color: var(--tp-text-secondary);
  }

  &__evidence-text {
    overflow-wrap: anywhere;
  }

  &__evidence-source {
    color: var(--tp-text-tertiary);
  }

  &__foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 10px;
  }

  &__suggestion {
    font-size: 13px;
    color: var(--tp-text-secondary);
  }

  &__actions {
    display: inline-flex;
    align-items: center;
    gap: 10px;
  }

  &__executed-at {
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }
}
</style>
