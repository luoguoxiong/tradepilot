<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'

import RhythmEditor from './RhythmEditor.vue'
import { createFollowUpStrategy, updateFollowUpStrategy } from '@/api/resources/follow-ups'
import type { AutoSendPolicy, FollowUpStrategy, StrategyStep } from '@/api/types/follow-up'

/**
 * 新建/编辑策略表单抽屉（07 §1.4 / §2.1，04 §3.5 最复杂表单 5 组字段）：
 * ① 策略名称 ② 适用范围（客户价值/行业/标签）③ 自动发送策略 ④ 跟进节奏（RhythmEditor）⑤ 启用开关。
 * 默认策略进入「复制并编辑」模式：预填副本名称，提交走新建（07 §7，前端复制提交新建）。
 */
const props = defineProps<{
  visible: boolean
  /** null = 新建；isDefault = 复制并编辑；其余 = 直接编辑 */
  strategy: FollowUpStrategy | null
}>()
const emit = defineEmits<{ 'update:visible': [v: boolean]; saved: [] }>()

const { t } = useI18n()

const name = ref('')
const customerValue = ref<Array<'high' | 'medium' | 'low'>>([])
const industries = ref<string[]>([])
const tags = ref<string[]>([])
const autoSendPolicy = ref<AutoSendPolicy>('manual_review')
const enabled = ref(true)
const steps = ref<StrategyStep[]>([])

const rhythmRef = ref<InstanceType<typeof RhythmEditor> | null>(null)
const submitting = ref(false)

/** 复制模式：默认策略不可直接修改，前端复制提交新建（07 §7） */
const isCopyMode = computed(() => Boolean(props.strategy?.isDefault))
const isEdit = computed(() => Boolean(props.strategy && !props.strategy.isDefault))
const drawerTitle = computed(() => {
  if (!props.strategy) return t('followUp.formCreate')
  return isCopyMode.value
    ? t('followUp.formCopy', { name: props.strategy.name })
    : t('followUp.formEdit', { name: props.strategy.name })
})

/** Break-up 节点存在时禁用「自动发送」（07 §4 强制人工审核） */
const hasBreakup = computed(() => steps.value.some((step) => step.isBreakup))

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return
    const source = props.strategy
    name.value = source
      ? isCopyMode.value
        ? t('followUp.copyNameSuffix', { name: source.name })
        : source.name
      : ''
    customerValue.value = source ? [...source.targetScope.customerValue] : ['high', 'medium']
    industries.value = source ? [...(source.targetScope.industry ?? [])] : []
    tags.value = source ? [...(source.targetScope.tags ?? [])] : []
    autoSendPolicy.value = source ? source.autoSendPolicy : 'manual_review'
    enabled.value = source ? source.enabled : true
    // 深拷贝，避免编辑未保存时污染列表数据
    steps.value = source ? (JSON.parse(JSON.stringify(source.steps)) as StrategyStep[]) : []
    if (!source) {
      steps.value = [
        { seq: 1, dayOffset: 0, title: '', channel: 'email' },
        { seq: 2, dayOffset: 3, title: '', channel: 'email' },
      ]
    }
    if (autoSendPolicy.value === 'auto_send') autoSendPolicy.value = 'manual_review'
  },
)

function onVisibleChange(visible: boolean) {
  emit('update:visible', visible)
}

async function onSubmit() {
  if (!name.value.trim()) {
    ElMessage.warning(t('followUp.nameRequired'))
    return
  }
  const rhythmError = rhythmRef.value?.validate()
  if (rhythmError) {
    ElMessage.warning(rhythmError)
    return
  }
  if (hasBreakup.value && autoSendPolicy.value === 'auto_send') {
    ElMessage.warning(t('followUp.breakupPolicyError'))
    return
  }
  submitting.value = true
  try {
    const payload = {
      name: name.value.trim(),
      targetScope: {
        customerValue: customerValue.value,
        industry: industries.value.length ? industries.value : undefined,
        tags: tags.value.length ? tags.value : undefined,
      },
      steps: steps.value,
      autoSendPolicy: autoSendPolicy.value,
      enabled: enabled.value,
    }
    if (isEdit.value && props.strategy) {
      await updateFollowUpStrategy(props.strategy.strategyId, payload)
    } else {
      await createFollowUpStrategy(payload)
    }
    ElMessage.success(t('followUp.saved'))
    emit('saved')
    onVisibleChange(false)
  } catch (error) {
    ElMessage.error((error as Error).message || t('common.operationFailed'))
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-drawer
    :model-value="props.visible"
    :title="drawerTitle"
    size="640px"
    :close-on-click-modal="false"
    @update:model-value="onVisibleChange"
  >
    <el-alert
      v-if="isCopyMode"
      :title="t('followUp.copyHint')"
      type="info"
      :closable="false"
      show-icon
      style="margin-bottom: 16px"
    />

    <el-form label-position="top">
      <!-- ① 策略名称 -->
      <el-form-item :label="t('followUp.name')" required>
        <el-input v-model="name" :placeholder="t('followUp.namePlaceholder')" maxlength="40" />
      </el-form-item>

      <!-- ② 适用范围（MVP 标注与筛选用，自动挂载 P1） -->
      <el-form-item :label="t('followUp.targetScope')">
        <div class="strategy-form__scope">
          <span class="strategy-form__scope-label">{{ t('followUp.customerValue') }}</span>
          <el-checkbox-group v-model="customerValue">
            <el-checkbox value="high">{{ t('enums.leadValue.high') }}</el-checkbox>
            <el-checkbox value="medium">{{ t('enums.leadValue.medium') }}</el-checkbox>
            <el-checkbox value="low">{{ t('enums.leadValue.low') }}</el-checkbox>
          </el-checkbox-group>
          <span class="strategy-form__scope-label">{{ t('crm.industry') }}</span>
          <el-select
            v-model="industries"
            multiple
            filterable
            allow-create
            default-first-option
            :placeholder="t('followUp.industryPlaceholder')"
            style="width: 100%"
          />
          <span class="strategy-form__scope-label">{{ t('followUp.tags') }}</span>
          <el-select
            v-model="tags"
            multiple
            filterable
            allow-create
            default-first-option
            :placeholder="t('followUp.tagsPlaceholder')"
            style="width: 100%"
          />
          <span class="strategy-form__scope-hint">{{ t('followUp.scopeHint') }}</span>
        </div>
      </el-form-item>

      <!-- ③ 自动发送策略 -->
      <el-form-item :label="t('followUp.autoSendPolicyLabel')">
        <el-radio-group v-model="autoSendPolicy">
          <el-radio value="manual_review">{{ t('enums.autoSendPolicy.manualReview') }}</el-radio>
          <el-radio value="auto_send" :disabled="hasBreakup">
            {{ t('enums.autoSendPolicy.autoSend') }}
          </el-radio>
          <el-radio value="value_based">{{ t('enums.autoSendPolicy.valueBased') }}</el-radio>
        </el-radio-group>
        <div class="strategy-form__policy-hint">
          {{ hasBreakup ? t('followUp.breakupTip') : t('followUp.policyHint') }}
        </div>
      </el-form-item>

      <!-- ④ 跟进节奏与内容 -->
      <el-form-item :label="t('followUp.rhythm')">
        <RhythmEditor ref="rhythmRef" v-model="steps" />
        <div class="strategy-form__policy-hint">{{ t('followUp.rhythmHint') }}</div>
      </el-form-item>

      <!-- ⑤ 启用开关 -->
      <el-form-item :label="t('followUp.enabled')">
        <el-switch v-model="enabled" />
        <span class="strategy-form__policy-hint" style="margin-left: 8px">
          {{ t('followUp.enabledHint') }}
        </span>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="onVisibleChange(false)">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="submitting" @click="onSubmit">
        {{ isCopyMode ? t('followUp.copyAndEdit') : t('common.save') }}
      </el-button>
    </template>
  </el-drawer>
</template>

<style scoped lang="scss">
.strategy-form {
  &__scope {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
  }

  &__scope-label {
    margin-top: 4px;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__scope-hint {
    margin-top: 4px;
    font-size: 12px;
    color: var(--tp-text-tertiary);
  }

  &__policy-hint {
    font-size: 12px;
    color: var(--tp-text-tertiary);
    line-height: 1.5;
  }
}
</style>
