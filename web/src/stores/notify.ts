import { defineStore } from 'pinia'

import { fetchApprovalSummary } from '@/api/resources/approvals'

/** 轮询节奏（03 §5.2 / 排期 M2-7）：15s，页面隐藏暂停、恢复可见立即刷一次 */
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

      const onVisible = () => {
        if (!document.hidden) void this.refresh()
      }
      document.addEventListener('visibilitychange', onVisible)

      const timer = window.setInterval(() => {
        if (!document.hidden) void this.refresh()
      }, POLL_INTERVAL)

      teardown = () => {
        window.clearInterval(timer)
        document.removeEventListener('visibilitychange', onVisible)
      }
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
