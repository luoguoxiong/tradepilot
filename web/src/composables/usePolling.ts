/**
 * 全局轮询收敛管理器（06 §3 / 排期 M3-1）：
 * 全站所有 setInterval 轮询（待审数、任务兜底轮询…）统一注册到同一管理器，
 * 页面隐藏统一暂停、恢复可见统一补刷一次，避免多计时器各自为政。
 */

interface PollTask {
  id: number
  interval: number
  fn: () => void | Promise<void>
  /** 恢复可见时是否立即补刷一次（默认 true） */
  catchUpOnVisible: boolean
}

const tasks = new Map<number, PollTask>()
let timer: ReturnType<typeof setInterval> | null = null
let visibilityHooked = false
let seq = 0

/** 收敛心跳：1s 粒度扫描，到期且页面可见才执行（隐藏期自然跳过 = 暂停） */
const TICK = 1_000
const nextAt = new Map<number, number>()

function ensureStarted() {
  if (timer) return
  timer = setInterval(tick, TICK)

  if (!visibilityHooked) {
    visibilityHooked = true
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
}

function tick() {
  if (document.hidden) return
  const now = Date.now()
  for (const [id, task] of tasks) {
    const at = nextAt.get(id) ?? 0
    if (now >= at) {
      nextAt.set(id, now + task.interval)
      void task.fn()
    }
  }
}

function onVisibilityChange() {
  if (document.hidden) return
  // 恢复可见：先到期的任务立即补刷一次，其余按剩余节奏继续
  const now = Date.now()
  for (const [id, task] of tasks) {
    if (task.catchUpOnVisible && (nextAt.get(id) ?? 0) <= now) void task.fn()
    nextAt.set(id, now + task.interval)
  }
}

/**
 * 注册轮询任务，返回停止函数（幂等：重复停止无害）。
 * @param fn 轮询体（异常由调用方自行兜底，管理器不做吞错）
 * @param interval 轮询间隔 ms（内部 1s 粒度对齐，短于 1s 的间隔会被向上取整）
 */
export function addPollTask(
  fn: () => void | Promise<void>,
  interval: number,
  options?: Partial<Pick<PollTask, 'catchUpOnVisible'>>,
): () => void {
  const id = ++seq
  tasks.set(id, {
    id,
    interval: Math.max(interval, TICK),
    fn,
    catchUpOnVisible: options?.catchUpOnVisible ?? true,
  })
  nextAt.set(id, Date.now() + tasks.get(id)!.interval)
  ensureStarted()

  return () => {
    tasks.delete(id)
    nextAt.delete(id)
    if (tasks.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}
