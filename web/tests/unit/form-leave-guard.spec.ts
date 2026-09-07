import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useFormLeaveGuard } from '@/composables/useFormLeaveGuard'

/**
 * useFormLeaveGuard 单测（排期 M4-5 / 02 §6）：
 * 表单页离开时拦截未保存变更 —— 无脏数据直接放行；脏数据确认「放弃」放行、取消停留。
 * 通过 mock vue-router/element-plus/vue-i18n 捕获 onBeforeRouteLeave 守卫并驱动 ElMessageBox。
 */

const h = vi.hoisted(() => ({
  captured: { guard: null as null | (() => Promise<boolean>) },
  confirm: vi.fn<() => Promise<unknown>>(),
}))

vi.mock('vue-router', () => ({
  onBeforeRouteLeave: (fn: () => Promise<boolean>) => {
    h.captured.guard = fn
  },
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('element-plus', () => ({
  ElMessageBox: { confirm: h.confirm },
}))

describe('useFormLeaveGuard', () => {
  beforeEach(() => {
    h.captured.guard = null
    h.confirm.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('无脏数据 → 直接放行且不弹确认', async () => {
    useFormLeaveGuard({ isDirty: () => false })
    expect(h.captured.guard).toBeDefined()
    await expect(h.captured.guard!()).resolves.toBe(true)
    expect(h.confirm).not.toHaveBeenCalled()
  })

  it('脏数据 + 确认放弃 → 放行', async () => {
    h.confirm.mockResolvedValue('confirm')
    useFormLeaveGuard({ isDirty: () => true })
    await expect(h.captured.guard!()).resolves.toBe(true)
    expect(h.confirm).toHaveBeenCalledTimes(1)
  })

  it('脏数据 + 取消 → 拦截（返回 false）', async () => {
    h.confirm.mockRejectedValue('cancel')
    useFormLeaveGuard({ isDirty: () => true })
    await expect(h.captured.guard!()).resolves.toBe(false)
  })

  it('自定义 message 透传', async () => {
    h.confirm.mockResolvedValue('confirm')
    const custom = 'custom message'
    useFormLeaveGuard({ isDirty: () => true, message: custom })
    await h.captured.guard!()
    expect(h.confirm).toHaveBeenCalledWith(
      custom,
      'common.unsavedTitle',
      expect.objectContaining({ type: 'warning' }),
    )
  })
})
