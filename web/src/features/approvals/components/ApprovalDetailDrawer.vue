<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { ElMessageBox } from 'element-plus'

import type { ApprovalItem, ApprovalStatus } from '@/api/types/approvals'
import { fetchApprovalLogs } from '@/api/resources/approvals'
import { formatInOrgTz } from '@/utils/date'
import { qk } from '@/query/keys'
import { useAuthStore } from '@/stores/auth'

import { isEmailSendContext } from '../utils/context'
import { notifyEmailSent, useApprovalDispose } from '../composables/useApprovalDispose'
import ApprovalCard from './ApprovalCard.vue'
import EditApproveDialog from './EditApproveDialog.vue'
import MailHtmlFrame from '@/features/inbox/components/MailHtmlFrame.vue'

/**
 * 审批详情抽屉（12 §3.2 详情 / §1.5 留痕）：
 * - 完整上下文：email_send 正文经 MailHtmlFrame 沙箱渲染（06 §4 安全基线）；
 * - 留痕时间线：approved/edited_approved（editedDiff）/rejected/expired/auto_approved；
 * - 处置动作复用 ApprovalCard 三态入口；编辑后批准由 EditApproveDialog 承载。
 */
const props = defineProps<{
  approval: ApprovalItem | null
}>()

const emit = defineEmits<{
  /** 处置成功后通知父级刷新列表 */
  disposed: []
}>()

const { t } = useI18n()
const auth = useAuthStore()
const { approve, reject } = useApprovalDispose()

const visible = defineModel<boolean>({ default: false })

const logsQuery = useQuery({
  queryKey: computed(() => qk.approvals.logs(props.approval?.approvalId ?? '')),
  queryFn: () => fetchApprovalLogs(props.approval!.approvalId),
  enabled: computed(() => visible.value && !!props.approval),
})

const emailContext = computed(() =>
  props.approval && isEmailSendContext(props.approval.context) ? props.approval.context : null,
)

const emailContent = computed(() => props.approval?.aiProposal.emailContent ?? '')

const logTagType = (action: ApprovalStatus | 'expired') => {
  switch (action) {
    case 'approved':
    case 'edited_approved':
    case 'auto_approved':
      return 'success'
    case 'rejected':
      return 'danger'
    default:
      return 'info'
  }
}

// ===== 编辑后批准 =====
const editVisible = ref(false)
const editDialogRef = ref<InstanceType<typeof EditApproveDialog> | null>(null)

async function onEditApproveConfirm(approvalId: string, emailContent: string): Promise<void> {
  const okResult = await approve(approvalId, {
    action: 'edited_approved',
    editedContent: { aiProposal: { emailContent } },
  })
  editDialogRef.value?.onSettled()
  if (okResult) {
    editVisible.value = false
    visible.value = false
    emit('disposed')
  }
}

async function onApprove(): Promise<void> {
  if (!props.approval) return
  const isEmailSend = props.approval.approvalType === 'email_send'
  const okResult = await approve(props.approval.approvalId, { action: 'approve' })
  if (okResult) {
    if (isEmailSend) notifyEmailSent(t)
    visible.value = false
    emit('disposed')
  }
}

/** 拒绝：reason 必填（12 §3.4，缺失 42201），弹窗收集理由 */
async function onReject(): Promise<void> {
  if (!props.approval) return
  try {
    const { value } = await ElMessageBox.prompt(
      t('approvals.rejectReasonTip'),
      t('approvals.reject'),
      {
        type: 'warning',
        inputPlaceholder: t('approvals.rejectReasonPlaceholder'),
        inputValidator: (input: string) =>
          input.trim().length > 0 ? true : t('approvals.rejectReasonRequired'),
        confirmButtonText: t('approvals.reject'),
        cancelButtonText: t('common.cancel'),
      },
    )
    const okResult = await reject(props.approval.approvalId, value.trim())
    if (okResult) {
      visible.value = false
      emit('disposed')
    }
  } catch {
    /* 用户取消 */
  }
}
</script>

<template>
  <el-drawer
    v-model="visible"
    :title="approval?.title ?? ''"
    size="520px"
    append-to-body
    destroy-on-close
    data-testid="approval-detail-drawer"
  >
    <template v-if="approval">
      <ApprovalCard
        :approval="approval"
        @approve="onApprove"
        @edit-approve="editVisible = true"
        @reject="onReject"
      />

      <!-- email_send：完整邮件正文（沙箱渲染） -->
      <section v-if="emailContext" class="detail__section">
        <h4 class="detail__section-title">{{ t('approvals.emailContent') }}</h4>
        <div class="detail__mail">
          <MailHtmlFrame plain :content="emailContent" min-height="160px" />
        </div>
      </section>

      <!-- 知识引用溯源 -->
      <section v-if="approval.citations?.length" class="detail__section">
        <h4 class="detail__section-title">{{ t('insight.citations') }}</h4>
        <el-tag
          v-for="citation in approval.citations"
          :key="`${citation.docId}:${citation.chunkId ?? ''}`"
          size="small"
          effect="plain"
          class="detail__citation"
        >
          {{ citation.docName }}
        </el-tag>
      </section>

      <!-- 留痕时间线（12 §1.5） -->
      <section class="detail__section" data-testid="approval-logs">
        <h4 class="detail__section-title">{{ t('approvals.logs') }}</h4>
        <el-timeline v-if="logsQuery.data.value?.length" class="detail__timeline">
          <el-timeline-item
            v-for="log in logsQuery.data.value"
            :key="log.logId"
            :timestamp="formatInOrgTz(log.decidedAt, auth.org?.timezone)"
            :type="logTagType(log.action)"
          >
            <div class="detail__log-head">
              <span class="detail__log-approver">{{ log.approverName }}</span>
              <el-tag size="small" :type="logTagType(log.action)" effect="light">
                {{ t(`approvals.action.${log.action}`) }}
              </el-tag>
            </div>
            <p v-if="log.rejectReason" class="detail__log-reason">{{ log.rejectReason }}</p>
            <div v-if="log.editedDiff?.length" class="detail__diff">
              <div v-for="diff in log.editedDiff" :key="diff.field" class="detail__diff-row">
                <span class="detail__diff-field">{{ diff.field }}</span>
                <div class="detail__diff-body detail__diff-body--before">{{ diff.before }}</div>
                <div class="detail__diff-body detail__diff-body--after">{{ diff.after }}</div>
              </div>
            </div>
          </el-timeline-item>
        </el-timeline>
        <p v-else class="detail__empty-logs">{{ t('approvals.noLogs') }}</p>
      </section>

      <!-- 编辑后批准对话框（挂本抽屉内，处置后关闭） -->
      <EditApproveDialog
        ref="editDialogRef"
        v-model="editVisible"
        :approval="approval"
        @confirm="onEditApproveConfirm"
      />
    </template>
  </el-drawer>
</template>

<style scoped lang="scss">
.detail__section {
  margin-top: 16px;
}

.detail__section-title {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-regular);
}

.detail__mail {
  overflow: hidden;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
}

.detail__citation {
  margin-right: 6px;
  margin-bottom: 6px;
}

.detail__timeline {
  padding-left: 4px;
}

.detail__log-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.detail__log-approver {
  font-size: 13px;
  font-weight: 500;
}

.detail__log-reason {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.detail__diff {
  margin-top: 6px;
}

.detail__diff-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.detail__diff-field {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.detail__diff-body {
  padding: 6px 8px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;

  &--before {
    border-left: 3px solid var(--el-color-danger-light-5);
    background: var(--el-fill-color-light);
    color: var(--el-text-color-secondary);
  }

  &--after {
    border-left: 3px solid var(--el-color-success-light-5);
    background: var(--el-color-success-light-9);
  }
}

.detail__empty-logs {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
