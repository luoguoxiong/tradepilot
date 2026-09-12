<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useQuery, useQueryClient } from '@tanstack/vue-query'

import EmptyState from '@/components/business/EmptyState.vue'
import StrategyTimeline from '../components/StrategyTimeline.vue'
import StrategyFormDrawer from '../components/StrategyFormDrawer.vue'
import ApplyStrategyDialog from '../components/ApplyStrategyDialog.vue'
import ExecutionsDrawer from '../components/ExecutionsDrawer.vue'
import { deleteFollowUpStrategy, getFollowUpStrategies } from '@/api/resources/follow-ups'
import type { FollowUpStrategy } from '@/api/types/follow-up'
import { handleApiError } from '@/api/error-handler'
import { qk } from '@/query/keys'
import { staleTime } from '@/query/options'
import { useDictStore } from '@/stores/dict'

defineOptions({ name: 'FollowUpStrategiesView' })

/**
 * 07 跟进策略（FR-03/FR-04/FR-07，04 §3.5）：
 * - 策略卡片墙：时间线 + 适用范围 + 自动发送策略；
 * - 默认策略「默认」标记、无删除入口、编辑 = 复制并编辑（07 §7 种子化）；
 * - 自建策略：编辑 / 删除（被进行中任务引用 40901）/ 应用到客户（单选/批量）。
 */
const { t } = useI18n()
const queryClient = useQueryClient()
const dict = useDictStore()

const strategiesQuery = useQuery({
  queryKey: qk.followUps.strategies(),
  queryFn: getFollowUpStrategies,
  staleTime: staleTime.LIST,
})

const strategies = computed<FollowUpStrategy[]>(() => strategiesQuery.data.value?.items ?? [])

// ===== 表单抽屉（新建 / 编辑 / 复制并编辑） =====
const formVisible = ref(false)
const formStrategy = ref<FollowUpStrategy | null>(null)

function openCreate() {
  formStrategy.value = null
  formVisible.value = true
}

function openEdit(strategy: FollowUpStrategy) {
  formStrategy.value = strategy
  formVisible.value = true
}

// ===== 应用到客户 =====
const applyVisible = ref(false)
const applyStrategy = ref<FollowUpStrategy | null>(null)

function openApply(strategy: FollowUpStrategy) {
  applyStrategy.value = strategy
  applyVisible.value = true
}

// ===== 执行记录 =====
const executionsVisible = ref(false)
const executionsStrategy = ref<FollowUpStrategy | null>(null)

function openExecutions(strategy: FollowUpStrategy) {
  executionsStrategy.value = strategy
  executionsVisible.value = true
}

async function onDelete(strategy: FollowUpStrategy) {
  const confirmed = await ElMessageBox.confirm(
    t('followUp.deleteConfirm', { name: strategy.name }),
    t('common.delete'),
    {
      type: 'warning',
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
    },
  ).catch(() => false)
  if (!confirmed) return
  try {
    await deleteFollowUpStrategy(strategy.strategyId)
    ElMessage.success(t('followUp.deleted'))
    void queryClient.invalidateQueries({ queryKey: qk.followUps.all })
  } catch (error) {
    // 被进行中任务引用 → 40901，由统一管道提示（04 §3.5）
    handleApiError(error)
  }
}

function scopeSummary(strategy: FollowUpStrategy): string {
  // targetScope.customerValue 允许省略（DTO optional / 旧数据 {}），防御缺省
  const values = (strategy.targetScope.customerValue ?? []).map((v) => t(`enums.leadValue.${v}`))
  const industry = strategy.targetScope.industry ?? []
  return [...values, ...industry].join(' / ') || t('followUp.scopeAll')
}

function stepsSummary(strategy: FollowUpStrategy): string {
  const days = strategy.steps.map((s) => s.dayOffset)
  return t('followUp.stepsSummary', { count: strategy.steps.length, days: days.join('/') })
}
</script>

<template>
  <div class="follow-up-strategies">
    <div class="follow-up-strategies__header">
      <div>
        <h3 class="follow-up-strategies__title">{{ t('followUp.strategiesTitle') }}</h3>
        <span class="follow-up-strategies__hint">{{ t('followUp.strategiesHint') }}</span>
      </div>
      <el-button type="primary" @click="openCreate">+ {{ t('followUp.createStrategy') }}</el-button>
    </div>

    <div v-loading="strategiesQuery.isLoading.value">
      <EmptyState v-if="!strategiesQuery.isLoading.value && strategies.length === 0" />
      <div v-else class="follow-up-strategies__grid">
        <el-card
          v-for="strategy in strategies"
          :key="strategy.strategyId"
          shadow="never"
          class="follow-up-strategies__card"
        >
          <template #header>
            <div class="follow-up-strategies__card-head">
              <span class="follow-up-strategies__name">{{ strategy.name }}</span>
              <el-tag v-if="strategy.isDefault" size="small" type="info" effect="plain">
                {{ t('followUp.defaultTag') }}
              </el-tag>
              <el-tag
                v-else
                size="small"
                :type="strategy.enabled ? 'success' : 'info'"
                effect="plain"
              >
                {{ strategy.enabled ? t('followUp.enabledOn') : t('followUp.enabledOff') }}
              </el-tag>
            </div>
          </template>

          <div class="follow-up-strategies__meta">
            <span>{{ t('followUp.targetScope') }}：{{ scopeSummary(strategy) }}</span>
            <span>{{ stepsSummary(strategy) }}</span>
            <span>
              {{ t('followUp.autoSendPolicyLabel') }}：
              <span :style="{ color: 'var(--tp-text-primary)' }">
                {{ dict.label('autoSendPolicy', strategy.autoSendPolicy) }}
              </span>
            </span>
          </div>

          <StrategyTimeline :strategy="strategy" />

          <div class="follow-up-strategies__footer">
            <el-button link type="primary" size="small" @click="openApply(strategy)">
              {{ t('followUp.apply') }}
            </el-button>
            <el-button link type="primary" size="small" @click="openExecutions(strategy)">
              {{ t('followUp.executions') }}
            </el-button>
            <el-button link type="primary" size="small" @click="openEdit(strategy)">
              {{ strategy.isDefault ? t('followUp.copyAndEdit') : t('crm.edit') }}
            </el-button>
            <el-button
              v-if="!strategy.isDefault"
              link
              type="danger"
              size="small"
              @click="onDelete(strategy)"
            >
              {{ t('common.delete') }}
            </el-button>
          </div>
        </el-card>
      </div>
    </div>

    <StrategyFormDrawer
      v-model:visible="formVisible"
      :strategy="formStrategy"
      @saved="queryClient.invalidateQueries({ queryKey: qk.followUps.all })"
    />
    <ApplyStrategyDialog
      v-model:visible="applyVisible"
      :strategy="applyStrategy"
      @applied="queryClient.invalidateQueries({ queryKey: qk.followUps.all })"
    />
    <ExecutionsDrawer v-model:visible="executionsVisible" :strategy="executionsStrategy" />
  </div>
</template>

<style scoped lang="scss">
.follow-up-strategies {
  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }

  &__title {
    margin: 0;
    font-size: 18px;
    color: var(--tp-text-primary);
  }

  &__hint {
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
    gap: 16px;
  }

  &__card-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  &__name {
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__meta {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 12px;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__footer {
    display: flex;
    justify-content: flex-end;
    gap: 4px;
    margin-top: 12px;
  }
}
</style>
