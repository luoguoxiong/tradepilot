<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { useQuery } from '@tanstack/vue-query'

import { applyFollowUpStrategy } from '@/api/resources/follow-ups'
import { getCustomers } from '@/api/resources/customers'
import { handleApiError } from '@/api/error-handler'
import type { ApplyStrategyResp, FollowUpStrategy } from '@/api/types/follow-up'
import type { CustomerItem } from '@/api/types/customers'
import { qk } from '@/query/keys'
import { staleTime } from '@/query/options'
import { useDictStore } from '@/stores/dict'

/**
 * 应用策略到客户（07 FR-07 / §3.5 apply）：
 * 单选/批量多选客户 → 创建跟进任务；客户已有进行中任务返回 skipped(task_exists)
 * （每客户同时仅 1 个进行中任务，07 §7）。
 */
const props = defineProps<{
  visible: boolean
  strategy: FollowUpStrategy | null
}>()
const emit = defineEmits<{ 'update:visible': [v: boolean]; applied: [] }>()

const { t } = useI18n()
const dict = useDictStore()

const selected = ref<string[]>([])
const submitting = ref(false)
const result = ref<ApplyStrategyResp | null>(null)

const customersQuery = useQuery({
  queryKey: [...qk.customers.list('apply-picker'), 'apply'],
  queryFn: () => getCustomers({ tab: 'potential', page: 1, pageSize: 100, scope: 'all' }),
  enabled: computed(() => props.visible),
  staleTime: staleTime.LIST,
})

const customers = computed<CustomerItem[]>(() => customersQuery.data.value?.items ?? [])

watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      selected.value = []
      result.value = null
    }
  },
)

async function onSubmit() {
  if (!props.strategy || selected.value.length === 0) {
    ElMessage.warning(t('followUp.applySelectRequired'))
    return
  }
  submitting.value = true
  try {
    result.value = await applyFollowUpStrategy(props.strategy.strategyId, {
      customerIds: selected.value,
    })
    ElMessage.success(
      t('followUp.applyDone', {
        created: result.value.created.length,
        skipped: result.value.skipped.length,
      }),
    )
    if (result.value.created.length > 0) emit('applied')
  } catch (error) {
    handleApiError(error)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="props.visible"
    :title="t('followUp.applyTitle', { name: props.strategy?.name ?? '' })"
    width="560px"
    @update:model-value="emit('update:visible', $event)"
  >
    <el-alert
      v-if="result"
      :title="
        t('followUp.applyResult', {
          created: result.created.length,
          skipped: result.skipped.length,
        })
      "
      :type="result.created.length > 0 ? 'success' : 'warning'"
      :closable="false"
      show-icon
      style="margin-bottom: 12px"
    />

    <div v-loading="customersQuery.isLoading.value" class="apply-picker">
      <el-checkbox-group v-model="selected" class="apply-picker__group">
        <el-checkbox
          v-for="customer in customers"
          :key="customer.customerId"
          :value="customer.customerId"
          class="apply-picker__item"
        >
          <span class="apply-picker__name">{{ customer.companyName }}</span>
          <span class="apply-picker__meta">
            {{ dict.label('customerStage', customer.stage) }} · {{ customer.ownerName }}
          </span>
        </el-checkbox>
      </el-checkbox-group>
      <div
        v-if="!customersQuery.isLoading.value && customers.length === 0"
        class="apply-picker__empty"
      >
        {{ t('followUp.applyNoCustomers') }}
      </div>
    </div>

    <template #footer>
      <el-button @click="emit('update:visible', false)">{{ t('common.close') }}</el-button>
      <el-button type="primary" :loading="submitting" @click="onSubmit">
        {{ t('followUp.applySubmit', { count: selected.length }) }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped lang="scss">
.apply-picker {
  max-height: 320px;
  overflow: auto;

  &__group {
    display: flex;
    flex-direction: column;
  }

  &__item {
    height: 32px;
    margin-right: 0;
  }

  &__name {
    font-weight: 500;
    color: var(--tp-text-primary);
  }

  &__meta {
    margin-left: 8px;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__empty {
    padding: 24px 0;
    text-align: center;
    font-size: 13px;
    color: var(--tp-text-tertiary);
  }
}
</style>
