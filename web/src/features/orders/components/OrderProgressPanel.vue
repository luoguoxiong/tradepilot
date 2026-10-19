<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQueryClient } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'

import { updateOrderProgress } from '@/api/resources/orders'
import { handleApiError } from '@/api/error-handler'
import type { OrderProgress, OrderTimelineEntry } from '@/api/types/orders'
import { qk } from '@/query/keys'

/**
 * 履约进度面板（10 §1.2 / §3.3 / FR-02）：
 * 进度四要素 → 状态由服务端推导（决策 A3），前端只提交四要素、不推定状态；
 * 更新成功后服务端自动重算履约风险并写进度流水，故刷新整个 qk.orders.all。
 */
const props = defineProps<{
  orderId: string
  progress: OrderProgress
  timeline: OrderTimelineEntry[]
}>()

const emit = defineEmits<{ updated: [] }>()

const { t } = useI18n()
const queryClient = useQueryClient()

const dialogVisible = ref(false)
const submitting = ref(false)

const draft = reactive<OrderProgress>({ ...props.progress })

function openDialog() {
  Object.assign(draft, props.progress)
  dialogVisible.value = true
}

const steps = [
  { key: 'poConfirmed', labelKey: 'orders.poConfirmed' },
  { key: 'payment', labelKey: 'orders.payment' },
  { key: 'production', labelKey: 'orders.productionPct' },
  { key: 'shipping', labelKey: 'orders.shipping' },
]

/** 当前阶段 = 前置动作完成数（生产 >0 即视为进入生产阶段） */
const activeStep = computed(() => {
  if (props.progress.shipping) return 4
  if (props.progress.productionPct > 0) return 3
  if (props.progress.payment) return 2
  if (props.progress.poConfirmed) return 1
  return 0
})

async function submit() {
  submitting.value = true
  try {
    await updateOrderProgress(props.orderId, {
      progress: {
        poConfirmed: draft.poConfirmed,
        payment: draft.payment,
        productionPct: Number(draft.productionPct),
        shipping: draft.shipping,
      },
    })
    ElMessage.success(t('orders.progressSaved'))
    dialogVisible.value = false
    await queryClient.invalidateQueries({ queryKey: qk.orders.all })
    emit('updated')
  } catch (error) {
    handleApiError(error)
  } finally {
    submitting.value = false
  }
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString()
}
</script>

<template>
  <div class="order-progress">
    <div class="order-progress__head">
      <span class="order-progress__title">{{ t('orders.progressTitle') }}</span>
      <el-button size="small" @click="openDialog">{{ t('orders.updateProgress') }}</el-button>
    </div>

    <el-steps :active="activeStep" simple class="order-progress__steps">
      <el-step v-for="step in steps" :key="step.key" :title="t(step.labelKey)" />
    </el-steps>

    <div class="order-progress__pct">
      <span>{{ t('orders.productionPct') }}</span>
      <el-progress :percentage="progress.productionPct" :stroke-width="12" />
    </div>

    <!-- 进度流水（服务端按四要素推导状态后落库，10 §3.3） -->
    <div class="order-progress__section">{{ t('orders.timelineTitle') }}</div>
    <el-timeline v-if="timeline.length" class="order-progress__timeline">
      <el-timeline-item
        v-for="entry in timeline"
        :key="entry.id"
        :timestamp="formatDateTime(entry.createdAt)"
      >
        {{ entry.note }}
      </el-timeline-item>
    </el-timeline>
    <p v-else class="order-progress__empty">{{ t('orders.timelineEmpty') }}</p>

    <!-- 更新进度（仅四要素；状态与风险由服务端推导） -->
    <el-dialog
      v-model="dialogVisible"
      :title="t('orders.progressTitleUpdate')"
      width="520px"
      append-to-body
    >
      <el-form label-width="110px">
        <el-form-item :label="t('orders.poConfirmed')">
          <el-switch v-model="draft.poConfirmed" />
        </el-form-item>
        <el-form-item :label="t('orders.payment')">
          <el-switch v-model="draft.payment" />
        </el-form-item>
        <el-form-item :label="t('orders.productionPct')">
          <el-input-number v-model="draft.productionPct" :min="0" :max="100" :step="5" />
        </el-form-item>
        <el-form-item :label="t('orders.shipping')">
          <el-switch v-model="draft.shipping" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">
          {{ t('common.save') }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped lang="scss">
.order-progress {
  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }

  &__title {
    font-size: 14px;
    font-weight: 600;
    color: var(--tp-text-primary);
  }

  &__steps {
    margin-bottom: 12px;
  }

  &__pct {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 13px;
    color: var(--tp-text-secondary);

    :deep(.el-progress) {
      flex: 1;
    }
  }

  &__section {
    margin: 14px 0 8px;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__timeline {
    padding-left: 2px;
    max-height: 260px;
    overflow-y: auto;
  }

  &__empty {
    margin: 0;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }
}
</style>
