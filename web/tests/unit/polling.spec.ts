import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { addPollTask } from '@/composables/usePolling'

/**
 * 全局轮询收敛管理器单测（06 §3 / 联调 4 §5）：
 * - 15s 节奏按 interval 周期触发；
 * - document.hidden 时 tick 跳过 = 隐藏暂停；
 * - 恢复可见 visibilitychange → 到期任务立即补刷，并按完整 interval 重新起算。
 * 注：真实浏览器中窗口遮挡会触发 Chrome 计时器节流（≥1min），属环境副作用，
 * 此处用假时钟消除干扰，只验证管理器自身逻辑。
 */

describe('usePolling 全局轮询收敛管理器', () => {
  let hiddenSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    hiddenSpy = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('按 interval 周期触发（15s 节奏）', async () => {
    const fn = vi.fn()
    const stop = addPollTask(fn, 15_000)

    await vi.advanceTimersByTimeAsync(15_000)
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fn).toHaveBeenCalledTimes(3) // +15s、+30s 两轮

    stop()
  })

  it('页面隐藏 → tick 跳过（暂停轮询）', async () => {
    const fn = vi.fn()
    const stop = addPollTask(fn, 15_000)

    hiddenSpy.mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(60_000) // 覆盖 4 个到期点
    expect(fn).not.toHaveBeenCalled()

    stop()
  })

  it('恢复可见 → 到期任务立即补刷，并按完整 interval 重新起算', async () => {
    const fn = vi.fn()
    const stop = addPollTask(fn, 15_000)

    // 隐藏期吞掉两个到期点
    hiddenSpy.mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fn).not.toHaveBeenCalled()

    // 恢复可见：事件同步触发补刷
    hiddenSpy.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(fn).toHaveBeenCalledTimes(1)

    // 补刷后重置节奏：+14999 不触发，+15000 触发
    await vi.advanceTimersByTimeAsync(14_999)
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fn).toHaveBeenCalledTimes(2)

    stop()
  })

  it('部分停止不影响其余任务；全部停止后重复 stop 幂等', async () => {
    const fnA = vi.fn()
    const fnB = vi.fn()
    const stopA = addPollTask(fnA, 15_000)
    const stopB = addPollTask(fnB, 15_000)

    stopA()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(fnA).not.toHaveBeenCalled()
    expect(fnB).toHaveBeenCalledTimes(1)

    expect(() => {
      stopA()
      stopB()
      stopB()
    }).not.toThrow()

    // 全部停止（心跳已清）后注册新任务仍可正常轮询
    const fnC = vi.fn()
    const stopC = addPollTask(fnC, 15_000)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(fnC).toHaveBeenCalledTimes(1)
    stopC()
  })
})
