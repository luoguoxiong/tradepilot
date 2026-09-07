import { ElNotification } from 'element-plus'

import type { Router } from 'vue-router'

import { i18n } from '@/locales'
import { queryClient } from '@/query/client'
import { qk } from '@/query/keys'
import { useNotifyStore } from '@/stores/notify'

/**
 * waiting_approval 全局通知 helper（M5 决策 10 / 04 §3.4）：
 * 任务进入等待审批态时弹 ElNotification + 刷新铃徽标 + 失效审批域缓存。
 * 模块级函数（全局 i18n + 单例 queryClient），可在组件外/回调中直接调用；
 * 接入点：useTaskStream 消费方 onStatus 回调 + send 分支 B onSuccess。
 */
let routerRef: Router | null = null

/** 由应用入口注入 router（避免循环依赖，main.ts 一次性调用） */
export function bindNotifyRouter(router: Router): void {
  routerRef = router
}

export function notifyWaitingApproval(linkedApprovalId?: string): void {
  const t = i18n.global.t
  const notify = useNotifyStore()

  void notify.invalidate()
  void queryClient.invalidateQueries({ queryKey: qk.approvals.all })

  ElNotification({
    title: t('notify.waitingApprovalTitle'),
    message: t('notify.waitingApprovalMessage'),
    type: 'warning',
    duration: 6000,
    onClick: () => {
      const target = linkedApprovalId ? `/approvals?approvalId=${linkedApprovalId}` : '/approvals'
      if (routerRef) void routerRef.push(target)
    },
  })
}
