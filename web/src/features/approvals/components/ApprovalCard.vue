<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlarmClock, Hide, View } from '@element-plus/icons-vue'

import type { ApprovalItem } from '@/api/types/approvals'
import { isCustomerDeleteContext, isEmailSendContext } from '../utils/context'

/**
 * 审批卡片（12 §2 审核中心列表行 / §1.2 全字段）：
 * - 风险分级：high 红（customer_delete 等一律人工审）/ medium 橙（email_send 可自动通过）；
 * - email_send 上下文：联系人/主题/正文预览；customer_delete：客户名/关联数；
 * - 置信度 + reasons 逐条证据；倒计时按 expiresAt（超时终态 expired 禁处置）；
 * - 三态处置入口：批准 / 编辑后批准 / 拒绝（详情抽屉承载完整上下文）。
 */
const props = defineProps<{
  approval: ApprovalItem
}>()

const emit = defineEmits<{
  approve: [approval: ApprovalItem]
  editApprove: [approval: ApprovalItem]
  reject: [approval: ApprovalItem]
  open: [approval: ApprovalItem]
}>()

const { t } = useI18n()

const isEmailSend = computed(() => props.approval.approvalType === 'email_send')
const emailContext = computed(() =>
  isEmailSendContext(props.approval.context) ? props.approval.context : null,
)
const deleteContext = computed(() =>
  props.approval.approvalType === 'customer_delete' &&
  isCustomerDeleteContext(props.approval.context)
    ? props.approval.context
    : null,
)

const isPending = computed(() => props.approval.status === 'pending')
const isExpired = computed(() => props.approval.status === 'expired')

const statusTagType = computed(() => {
  switch (props.approval.status) {
    case 'pending':
      return 'warning'
    case 'approved':
    case 'edited_approved':
    case 'auto_approved':
      return 'success'
    case 'rejected':
      return 'danger'
    case 'expired':
      return 'info'
  }
  return 'info'
})

const confidencePct = computed(() => Math.round(props.approval.confidence * 100))

/** 剩余时间静态口径（打开页面时点）：负数表示已超时 */
const remainingHours = computed(() => {
  if (!props.approval.expiresAt) return null
  return Math.ceil((new Date(props.approval.expiresAt).getTime() - Date.now()) / 3600_000)
})

const remainingText = computed(() => {
  if (remainingHours.value === null) return ''
  if (remainingHours.value <= 0) return t('approvals.expired')
  if (remainingHours.value >= 48)
    return t('approvals.remainingDays', { count: Math.round(remainingHours.value / 24) })
  return t('approvals.remainingHours', { count: remainingHours.value })
})
</script>

<template>
  <el-card class="approval-card" shadow="never" data-testid="approval-card">
    <header class="approval-card__head">
      <div class="approval-card__title-wrap">
        <el-tag
          :type="approval.riskLevel === 'high' ? 'danger' : 'warning'"
          size="small"
          effect="dark"
          round
        >
          {{ t(`approvals.risk.${approval.riskLevel}`) }}
        </el-tag>
        <h3 class="approval-card__title">{{ approval.title }}</h3>
        <el-tag :type="statusTagType" size="small" effect="light" data-testid="approval-status">
          {{ t(`approvals.status.${approval.status}`) }}
        </el-tag>
      </div>
      <div class="approval-card__countdown">
        <el-icon v-if="isPending"><AlarmClock /></el-icon>
        <span :class="{ 'is-expired': isExpired }">{{ remainingText }}</span>
      </div>
    </header>

    <!-- 上下文摘要 -->
    <div class="approval-card__context">
      <template v-if="emailContext">
        <div class="approval-card__context-row">
          <span class="approval-card__context-label">{{ t('approvals.contact') }}</span>
          <span>{{ emailContext.contactName }}</span>
        </div>
        <div class="approval-card__context-row">
          <span class="approval-card__context-label">{{ t('approvals.subject') }}</span>
          <span class="approval-card__subject">{{ emailContext.subject }}</span>
        </div>
        <p class="approval-card__preview">{{ emailContext.contentPreview }}…</p>
      </template>
      <template v-else-if="deleteContext">
        <div class="approval-card__context-row">
          <span class="approval-card__context-label">{{ t('approvals.customer') }}</span>
          <span>{{ deleteContext.customerName }}</span>
        </div>
        <div class="approval-card__context-row">
          <span class="approval-card__context-label">{{ t('approvals.relatedCounts') }}</span>
          <span>
            {{ t('approvals.quotes') }} {{ deleteContext.relatedCounts.quotes }} ·
            {{ t('approvals.orders') }} {{ deleteContext.relatedCounts.orders }}
          </span>
        </div>
      </template>
    </div>

    <!-- 置信度 + 判断原因 -->
    <div class="approval-card__evidence">
      <div class="approval-card__confidence">
        <span class="approval-card__context-label">{{ t('approvals.confidence') }}</span>
        <el-progress
          :percentage="confidencePct"
          :stroke-width="8"
          :color="confidencePct >= 80 ? '#67c23a' : confidencePct >= 50 ? '#e6a23c' : '#909399'"
          class="approval-card__confidence-bar"
        />
      </div>
      <ul v-if="approval.reasons.length" class="approval-card__reasons">
        <li v-for="(reason, index) in approval.reasons" :key="index">
          <span class="approval-card__reason-text">{{ reason.text }}</span>
          <span v-if="reason.evidence" class="approval-card__reason-evidence">{{
            reason.evidence
          }}</span>
        </li>
      </ul>
    </div>

    <!-- 处置动作 -->
    <footer class="approval-card__actions">
      <el-button link type="primary" size="small" :icon="View" @click="emit('open', approval)">
        {{ t('approvals.viewDetail') }}
      </el-button>
      <template v-if="isPending">
        <!-- 12 §4：审批处置仅限 admin/manager（05 §3.2 基线，服务端 40301 为权威） -->
        <el-button
          v-permission="['admin', 'manager']"
          type="success"
          size="small"
          plain
          @click="emit('approve', approval)"
        >
          {{ t('approvals.approve') }}
        </el-button>
        <el-button
          v-if="isEmailSend"
          v-permission="['admin', 'manager']"
          type="primary"
          size="small"
          plain
          @click="emit('editApprove', approval)"
        >
          {{ t('approvals.editApprove') }}
        </el-button>
        <el-button
          v-permission="['admin', 'manager']"
          type="danger"
          size="small"
          plain
          @click="emit('reject', approval)"
        >
          {{ t('approvals.reject') }}
        </el-button>
      </template>
      <span v-else-if="isExpired" class="approval-card__expired-tip">
        <el-icon><Hide /></el-icon>
        {{ t('approvals.expiredTip') }}
      </span>
      <span v-else class="approval-card__approver">
        {{ approval.approverName }}
        <template v-if="approval.rejectReason"> · {{ approval.rejectReason }}</template>
      </span>
    </footer>
  </el-card>
</template>

<style scoped lang="scss">
.approval-card {
  --el-card-padding: 14px 16px;

  margin-bottom: 12px;

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  &__title-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  &__title {
    margin: 0;
    overflow: hidden;
    font-size: 14px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__countdown {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: var(--el-text-color-secondary);

    .is-expired {
      color: var(--el-text-color-placeholder);
    }
  }

  &__context {
    margin-top: 10px;
    padding: 10px 12px;
    border-radius: 6px;
    background: var(--el-fill-color-light);
  }

  &__context-row {
    display: flex;
    gap: 8px;
    margin-bottom: 4px;
    font-size: 13px;

    &:last-child {
      margin-bottom: 0;
    }
  }

  &__context-label {
    flex-shrink: 0;
    color: var(--el-text-color-secondary);
  }

  &__subject {
    font-weight: 500;
  }

  &__preview {
    margin: 6px 0 0;
    font-size: 12px;
    color: var(--el-text-color-secondary);
    line-height: 1.6;
  }

  &__evidence {
    margin-top: 10px;
  }

  &__confidence {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  &__confidence-bar {
    width: 160px;
  }

  &__reasons {
    margin: 8px 0 0;
    padding: 0;
    list-style: none;

    li {
      display: flex;
      gap: 8px;
      margin-bottom: 4px;
      font-size: 12px;
      line-height: 1.6;

      &::before {
        content: '·';
        color: var(--el-text-color-placeholder);
      }
    }
  }

  &__reason-text {
    color: var(--el-text-color-regular);
  }

  &__reason-evidence {
    color: var(--el-text-color-secondary);
  }

  &__actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;

    .el-button + .el-button {
      margin-left: 0;
    }
  }

  &__expired-tip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: var(--el-text-color-placeholder);
  }

  &__approver {
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }
}
</style>
