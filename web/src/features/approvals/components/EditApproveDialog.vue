<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { ApprovalItem } from '@/api/types/approvals'
import { isEmailSendContext } from '../utils/context'
import DraftEditor from '@/features/inbox/components/DraftEditor.vue'

/**
 * 编辑后批准对话框（12 §3.3 action=edited_approved）：
 * - 预填 aiProposal.emailContent 到 DraftEditor，人工修订后整体替换提交；
 * - 服务端记录 editedDiff（aiProposal.emailContent before/after，v0.1 整体替换留痕）；
 * - 仅 email_send 类型提供编辑后批准（customer_delete 无可编辑内容，12 §2）。
 */
const props = defineProps<{
  approval: ApprovalItem | null
}>()

const emit = defineEmits<{
  confirm: [approvalId: string, emailContent: string]
}>()

const { t } = useI18n()

const visible = defineModel<boolean>({ default: false })
const content = ref('')
const submitting = ref(false)

watch(visible, (open) => {
  if (open && props.approval && isEmailSendContext(props.approval.context)) {
    content.value = props.approval.aiProposal.emailContent ?? ''
  }
})

function onConfirm(): void {
  if (!props.approval || !content.value.trim()) return
  submitting.value = true
  emit('confirm', props.approval.approvalId, content.value)
}

/** 提交结束由父组件关闭（失败保持打开修订） */
function onSettled(): void {
  submitting.value = false
}

defineExpose({ onSettled })
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="t('approvals.editApproveTitle')"
    width="640px"
    destroy-on-close
    append-to-body
    data-testid="edit-approve-dialog"
  >
    <p v-if="approval && isEmailSendContext(approval.context)" class="edit-approve__subject">
      {{ t('approvals.subject') }}: {{ approval.context.subject }}
    </p>
    <DraftEditor v-model="content" :min-height="220" data-testid="edit-approve-editor" />
    <template #footer>
      <el-button @click="visible = false">{{ t('common.cancel') }}</el-button>
      <el-button
        type="primary"
        :disabled="!content.trim() || content === approval?.aiProposal.emailContent"
        :loading="submitting"
        data-testid="edit-approve-confirm"
        @click="onConfirm"
      >
        {{ t('approvals.editApprove') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped lang="scss">
.edit-approve__subject {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
</style>
