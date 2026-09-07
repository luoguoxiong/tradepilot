import { defineStore } from 'pinia'

import { fetchApprovalSummary } from '@/api/resources/approvals'
import { addPollTask } from '@/composables/usePolling'

/** 轮询节奏（03 §5.2 / 排期 M2-7）：15s；隐藏暂停/恢复补刷由全局轮询管理器统一收敛 */
const POLL_INTERVAL = 15_000

/** 模块级 stop 句柄：timer/监听器不进 state（避免被持久化或 devtools 噪音） */
let teardown: (() => void) | null = null

interface NotifyState {
  /** 待审总数（tabs.type === 'all'），Header 通知铃徽标 */
  pendingCount: number
  /** 分类待审数（审核中心 Tab / 铃标下拉） */
  tabs: { type: string; count: number }[]
  polling: boolean
}

export const useNotifyStore = defineStore('notify', {
  state: (): NotifyState => ({ pendingCount: 0, tabs: [], polling: false }),

  actions: {
    async refresh() {
      try {
        const summary = await fetchApprovalSummary()
        this.tabs = summary.tabs
        this.pendingCount = summary.tabs.find((tab) => tab.type === 'all')?.count ?? 0
      } catch {
        // 轮询失败静默：保留上次计数，下个周期重试
      }
    },

    startPolling() {
      if (this.polling) return
      this.polling = true
      void this.refresh()

      // 全局轮询收敛管理器（06 §3）：隐藏暂停 / 恢复补刷统一处理
      teardown = addPollTask(() => this.refresh(), POLL_INTERVAL)
    },

    stopPolling() {
      teardown?.()
      teardown = null
      this.polling = false
    },

    /** 审批处置成功后立即刷新徽标（04 §3.4 notifyStore 联动） */
    async invalidate() {
      await this.refresh()
    },
  },
})
