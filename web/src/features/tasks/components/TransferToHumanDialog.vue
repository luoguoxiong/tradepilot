<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'

import { batchTaskAction, transferTaskToHuman } from '@/api/resources/tasks'
import { handleApiError } from '@/api/error-handler'
import type { TransferToHumanReq } from '@/api/types/tasks'

/**
 * TransferToHumanDialog 转人工（14 §3.6/§3.7 / FR-03）：
 * - 单任务：提交 reason/assignee/summary，服务端追加 handoff 交接摘要到产出物；
 * - 批量（失败批量处理）：仅提交 reason，走 POST /tasks/batch（逐条返回结果）。
 */
const props = withDefaults(
  defineProps<{
    modelValue: boolean
    taskIds: string[]
    batch?: boolean
  }>(),
  { batch: false },
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  saved: []
}>()

const { t } = useI18n()

const submitting = ref(false)
const form = reactive<TransferToHumanReq>({ reason: '', assignee: '', summary: '' })

const title = computed(() =>
  props.batch
    ? t('tasks.transferBatchTitle', { count: props.taskIds.length })
    : t('tasks.transferTitle'),
)

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      form.reason = ''
      form.assignee = ''
      form.summary = ''
    }
  },
)

async function submit() {
  if (props.taskIds.length === 0) return
  submitting.value = true
  try {
    if (props.batch) {
      const resp = await batchTaskAction({
        action: 'transfer_to_human',
        taskIds: props.taskIds,
        reason: form.reason?.trim() || undefined,
      })
      if (resp.failed > 0) {
        ElMessage.warning(
          t('tasks.batchResultPartial', { succeeded: resp.succeeded, failed: resp.failed }),
        )
      } else {
        ElMessage.success(t('tasks.batchResultAllDone', { count: resp.succeeded }))
      }
    } else {
      const payload: TransferToHumanReq = {}
      if (form.reason?.trim()) payload.reason = form.reason.trim()
      if (form.assignee?.trim()) payload.assignee = form.assignee.trim()
      if (form.summary?.trim()) payload.summary = form.summary.trim()
      await transferTaskToHuman(props.taskIds[0], payload)
      ElMessage.success(t('tasks.transferSuccess'))
    }
    emit('saved')
    emit('update:modelValue', false)
  } catch (error) {
    handleApiError(error)
  } finally {
    submitting.value = false
  }
}

function close() {
  emit('update:modelValue', false)
}
</script>

<template>
  <el-dialog
    :model-value="props.modelValue"
    :title="title"
    width="560px"
    :close-on-click-modal="false"
    append-to-body
    @close="close"
  >
    <el-alert type="info" :closable="false" :title="t('tasks.transferTip')" class="transfer__tip" />

    <el-form :model="form" label-width="90px">
      <el-form-item :label="t('tasks.reason')">
        <el-input
          v-model="form.reason"
          type="textarea"
          :rows="2"
          :placeholder="t('tasks.reasonPlaceholder')"
        />
      </el-form-item>

      <template v-if="!props.batch">
        <el-form-item :label="t('tasks.assignee')">
          <el-input v-model="form.assignee" :placeholder="t('tasks.assigneePlaceholder')" />
        </el-form-item>
        <el-form-item :label="t('tasks.summary')">
          <el-input
            v-model="form.summary"
            type="textarea"
            :rows="3"
            :placeholder="t('tasks.summaryPlaceholder')"
          />
        </el-form-item>
      </template>
    </el-form>

    <template #footer>
      <el-button @click="close">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" :loading="submitting" @click="submit">
        {{ t('tasks.transferSubmit') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped lang="scss">
.transfer__tip {
  margin-bottom: 12px;
}
</style>
