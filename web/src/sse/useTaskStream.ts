import { fetchEventSource } from '@microsoft/fetch-event-source'
import { onScopeDispose, reactive, unref, type MaybeRef } from 'vue'

import { getTask, getTaskLogs } from '@/api/resources/tasks'
import type { TaskLog, TaskStatus } from '@/api/types/tasks'
import { isTerminalStatus } from '@/query/options'

/**
 * useTaskStream —— 任务实时流统一封装（03 §5.4/§6.2）：
 * - SSE（fetch-event-source，可携带 Bearer 头）按事件类型归并：log/progress/status/done；
 * - 幂等续传：连接前先拉 /logs 建立基线；log 按 logId 去重排序，重连窗口不丢不重；
 * - 断线重连：指数退避 1s→2s→4s…（上限 30s），最多 maxRetries 次；
 * - 降级：重连耗尽 → 轮询 /logs?after=<lastLogId>（增量、hasMore 翻页）+ /tasks/{id} 状态，UI 无感；
 * - 生命周期：作用域销毁 abort；页面隐藏暂停、恢复可见补拉增量日志后重连；
 * - done 终态：主动 close 并触发 onDone（调用方 invalidate 相关 query）。
 */
export interface TaskStreamOptions {
  /** 重试基础延迟 ms（指数退避基数），默认 1000 */
  retryBaseMs?: number
  /** 重试延迟上限 ms，默认 30000 */
  retryMaxMs?: number
  /** 最大重试次数，超过后降级轮询，默认 5 */
  maxRetries?: number
  /** 降级轮询间隔 ms，默认 3000 */
  pollIntervalMs?: number
  /** done 终态回调（invalidate 任务相关 query） */
  onDone?: (status: TaskStatus) => void
  /** status 事件回调（如 waiting_approval 全局通知联动） */
  onStatus?: (status: TaskStatus, linkedApprovalId?: string) => void
}

export interface TaskStreamState {
  status: TaskStatus | null
  progressPct: number
  currentStep: string
  foundCount: number | null
  targetCount: number | null
  logs: TaskLog[]
  outputs: unknown[] | null
  linkedApprovalId: string | null
  /** 任务失败原因（failed 时） */
  error: string | null
  /** 数据源：sse / polling（降级）/ done（终态收流） */
  source: 'idle' | 'sse' | 'polling' | 'done'
  reconnecting: boolean
}

const TERMINAL: TaskStatus[] = ['completed', 'failed', 'canceled']

/** logId 排序比较：数字后缀按数值比（log-12 > log-9），其余按字典序 */
function compareLogId(a: string, b: string): number {
  const na = /(\d+)$/.exec(a)
  const nb = /(\d+)$/.exec(b)
  if (na && nb) return Number(na[1]) - Number(nb[1])
  return a < b ? -1 : a > b ? 1 : 0
}

export function useTaskStream(taskId: MaybeRef<string>, options: TaskStreamOptions = {}) {
  const {
    retryBaseMs = 1_000,
    retryMaxMs = 30_000,
    maxRetries = 5,
    pollIntervalMs = 3_000,
    onDone,
    onStatus,
  } = options

  const state = reactive<TaskStreamState>({
    status: null,
    progressPct: 0,
    currentStep: '',
    foundCount: null,
    targetCount: null,
    logs: [],
    outputs: null,
    linkedApprovalId: null,
    error: null,
    source: 'idle',
    reconnecting: false,
  })

  let id = unref(taskId)
  let attempts = 0
  let abort: AbortController | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let visibilityHooked = false

  const seen = new Set<string>()

  function isTerminal() {
    return state.status !== null && TERMINAL.includes(state.status)
  }

  /** 追加日志：按 logId 去重 + 有序插入（03 §6.2 幂等续传语义） */
  function appendLogs(items: TaskLog[]) {
    const fresh = items.filter((l) => !seen.has(l.logId))
    if (fresh.length === 0) return
    for (const log of fresh) seen.add(log.logId)
    state.logs.push(...fresh)
    state.logs.sort((a, b) => compareLogId(a.logId, b.logId))
  }

  function applyProgress(p: {
    progressPct?: number
    currentStep?: string
    foundCount?: number
    targetCount?: number
  }) {
    if (p.progressPct !== undefined) state.progressPct = p.progressPct
    if (p.currentStep !== undefined) state.currentStep = p.currentStep
    if (p.foundCount !== undefined) state.foundCount = p.foundCount
    if (p.targetCount !== undefined) state.targetCount = p.targetCount
  }

  function applyStatus(status: TaskStatus, linkedApprovalId?: string) {
    state.status = status
    if (linkedApprovalId) state.linkedApprovalId = linkedApprovalId
    onStatus?.(status, state.linkedApprovalId ?? undefined)
  }

  /** 终态收流：close 一切资源 */
  function finish(status: TaskStatus) {
    state.status = status
    state.source = 'done'
    state.reconnecting = false
    close()
    onDone?.(status)
  }

  function close() {
    abort?.abort()
    abort = null
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
  }

  /** 增量补拉：after=lastLogId 翻页直到追平（降级轮询单次 tick / 重连前 catch-up 共用） */
  async function catchUp(): Promise<void> {
    for (;;) {
      const last = state.logs[state.logs.length - 1]?.logId ?? ''
      const resp = await getTaskLogs(id, last)
      appendLogs(resp.items)
      if (!resp.hasMore) return
    }
  }

  /** 降级轮询：SSE 重连耗尽后接管（UI 无感，03 §6.2） */
  function startPolling() {
    if (stopped || isTerminal() || pollTimer) return
    state.source = 'polling'
    state.reconnecting = false

    const tick = async () => {
      pollTimer = null
      if (stopped || isTerminal()) return
      try {
        await catchUp()
        const detail = await getTask(id)
        applyProgress(detail)
        if (detail.currentStep) state.currentStep = detail.currentStep
        if (isTerminalStatus(detail.status)) {
          state.outputs = detail.outputs ?? null
          state.error = detail.error ?? null
          finish(detail.status)
          return
        }
      } catch {
        // 轮询失败静默：下个周期重试
      }
      if (!stopped && !isTerminal()) pollTimer = setTimeout(tick, pollIntervalMs)
    }
    void tick()
  }

  /** 打开 SSE 流（指数退避重连；重连前先增量补拉防丢日志） */
  async function connect() {
    if (stopped || isTerminal()) return
    state.source = 'sse'
    state.reconnecting = attempts > 0
    abort = new AbortController()

    try {
      await fetchEventSource(`/api/v1/tasks/${id}/stream`, {
        signal: abort.signal,
        openWhenHidden: true, // 隐藏暂停/恢复由本 composable 自管（含补拉语义）
        headers: {
          Authorization: `Bearer ${localStorage.getItem('tradepilot.token') ?? ''}`,
        },
        async onopen(response) {
          if (!response.ok) throw new Error(`SSE ${response.status}`)
          attempts = 0
          state.reconnecting = false
        },
        onmessage(msg) {
          const data = msg.data ? JSON.parse(msg.data) : {}
          switch (msg.event) {
            case 'log': {
              appendLogs([data as TaskLog])
              break
            }
            case 'progress': {
              applyProgress(data)
              break
            }
            case 'status': {
              applyStatus(data.status as TaskStatus, data.linkedApprovalId)
              break
            }
            case 'done': {
              state.outputs = data.outputs ?? null
              state.error = data.error ?? null
              finish(data.status as TaskStatus)
              break
            }
          }
        },
        onerror() {
          // 抛错中止 → 由本层接管重试节奏；未超上限则返回延迟自动重连
          if (stopped || isTerminal()) throw new Error('stream closed')
          attempts += 1
          if (attempts > maxRetries) {
            startPolling()
            throw new Error('retry exhausted')
          }
          state.reconnecting = true
          void catchUp().catch(() => undefined)
          return Math.min(retryBaseMs * 2 ** (attempts - 1), retryMaxMs)
        },
      })
    } catch {
      // fetchEventSource 抛错 = onerror 已决定停止（降级轮询）或作用域中止
      if (!stopped && !isTerminal() && state.source === 'sse' && attempts > maxRetries) {
        startPolling()
      }
    }
  }

  /** 暂停（页面隐藏）：abort SSE，轮询 tick 自检 hidden 跳过 */
  function pause() {
    abort?.abort()
    abort = null
  }

  async function resume() {
    if (stopped || isTerminal()) return
    try {
      await catchUp()
    } catch {
      // 补拉失败不阻塞重连，SSE 重连窗口内仍有去重兜底
    }
    if (!isTerminal()) void connect()
  }

  function onVisibility() {
    if (document.hidden) {
      pause()
    } else {
      void resume()
    }
  }

  async function start() {
    id = unref(taskId)
    if (!id || stopped) return
    if (!visibilityHooked) {
      visibilityHooked = true
      document.addEventListener('visibilitychange', onVisibility)
    }

    // 1) 建立基线：存量日志 + 当前状态（幂等续传，03 §6.2）
    try {
      await catchUp()
      const detail = await getTask(id)
      applyProgress(detail)
      if (detail.currentStep) state.currentStep = detail.currentStep
      if (detail.error) state.error = detail.error
      if (isTerminalStatus(detail.status)) {
        state.outputs = detail.outputs ?? null
        finish(detail.status)
        return
      }
      applyStatus(detail.status)
    } catch {
      state.error = 'task load failed'
    }

    // 2) 打开实时流
    void connect()
  }

  /** 作用域销毁：abort 全部资源并摘除监听（组件卸载/路由离开语义） */
  function stop() {
    stopped = true
    close()
    if (visibilityHooked) {
      document.removeEventListener('visibilitychange', onVisibility)
      visibilityHooked = false
    }
  }

  onScopeDispose(stop)

  return { state, start, stop, /** 供测试注入后手动触发 */ resume, pause }
}
