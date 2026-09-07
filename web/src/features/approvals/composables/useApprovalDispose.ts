import { useI18n } from 'vue-i18n'
import { useQueryClient } from '@tanstack/vue-query'
import { ElMessage, ElNotification } from 'element-plus'

import type { ApproveReq } from '@/api/types/approvals'
import type { ApiError } from '@/api/http'
import {
  approveApproval,
  rejectApproval,
} from '@/api/resources/approvals'
import { qk } from '@/query/keys'
import { useNotifyStore } from '@/stores/notify'

/**
 * 审批处置组合式（12 §3.3/§3.4，M5-4）：
 * - approve（批准 / 编辑后批准）：email_send 回调原业务 → 邮件真实发出；
 * - reject：reason 必填（缺失 42201），回流 AI 员工反馈闭环；
 * - 处置成功统一失效审批域 + notifyStore 徽标 + 会话/客户域（跨模块回写）；
 * - 终态容错：expired → 42201、重复处置 → 40901 由 http 层转译为业务提示。
 */
export function useApprovalDispose() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const notify = useNotifyStore()

  function invalidateAll(): void {
    void queryClient.invalidateQueries({ queryKey: qk.approvals.all })
    void queryClient.invalidateQueries({ queryKey: qk.conversations.all })
    void queryClient.invalidateQueries({ queryKey: qk.customers.all })
    void queryClient.invalidateQueries({ queryKey: qk.activities.all })
    void notify.invalidate()
  }

  function onError(error: ApiError): void {
    ElMessage.error(error.message || t('common.operationFailed'))
  }

  async function approve(approvalId: string, data: ApproveReq): Promise<boolean> {
    try {
      const result = await approveApproval(approvalId, data)
      ElMessage.success(
        result.status === 'edited_approved' ? t('approvals.done.editedApproved') : t('approvals.done.approved'),
      )
      invalidateAll()
      return true
    } catch (error) {
      onError(error as ApiError)
      return false
    }
  }

  async function reject(approvalId: string, reason: string): Promise<boolean> {
    try {
      await rejectApproval(approvalId, { reason })
      ElMessage.success(t('approvals.done.rejected'))
      invalidateAll()
      return true
    } catch (error) {
      onError(error as ApiError)
      return false
    }
  }

  return { approve, reject }
}

/** 处置成功后的提醒（email_send 回调原业务 → 邮件已发出，供 ApprovalsView 调用） */
export function notifyEmailSent(t: (key: string) => string): void {
  ElNotification({
    title: t('approvals.notify.sentTitle'),
    message: t('approvals.notify.sentMessage'),
    type: 'success',
    duration: 4500,
  })
}
