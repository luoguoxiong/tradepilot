import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ErrorCode } from '@/api/error-codes'
import { handleApiError } from '@/api/error-handler'
import { ApiError, parseRetryAfter } from '@/api/http'

/**
 * 统一错误码管道单测（03 §4 / 联调计划表 #1）：
 * 覆盖 40001~50301 各 code → UI 行为映射，确保页面无需各自 switch 错误码。
 */

const h = vi.hoisted(() => ({
  message: {
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
  notification: vi.fn(),
}))

vi.mock('element-plus', () => ({
  ElMessage: h.message,
  ElNotification: h.notification,
}))

beforeEach(() => {
  h.message.error.mockReset()
  h.message.warning.mockReset()
  h.notification.mockReset()
})

describe('handleApiError 错误码 → UI 行为', () => {
  it('40101 未认证：静默（会话由 http 层清理，守卫接管跳转）', () => {
    const error = handleApiError(new ApiError(ErrorCode.UNAUTHORIZED, '登录已失效'))
    expect(error.code).toBe(ErrorCode.UNAUTHORIZED)
    expect(h.message.error).not.toHaveBeenCalled()
    expect(h.message.warning).not.toHaveBeenCalled()
    expect(h.notification).not.toHaveBeenCalled()
  })

  it('40001 参数错误：默认 warning', () => {
    handleApiError(new ApiError(ErrorCode.BAD_REQUEST, '字段缺失'))
    expect(h.message.warning).toHaveBeenCalledWith('字段缺失')
  })

  it('40001 参数错误：onBadRequest 内联处理后不再弹提示', () => {
    const onBadRequest = vi.fn().mockReturnValue(true)
    handleApiError(new ApiError(ErrorCode.BAD_REQUEST, '字段缺失'), { onBadRequest })
    expect(onBadRequest).toHaveBeenCalledTimes(1)
    expect(h.message.warning).not.toHaveBeenCalled()
  })

  it('40001 明细透传：onBadRequest 可读 details.issues 做字段映射', () => {
    const onBadRequest = vi.fn((error: ApiError) => {
      expect((error.details as { issues: unknown[] }).issues).toHaveLength(1)
      return true
    })
    handleApiError(
      new ApiError(ErrorCode.BAD_REQUEST, '参数错误', undefined, undefined, {
        issues: [{ path: 'page', message: 'too small' }],
      }),
      { onBadRequest },
    )
    expect(onBadRequest).toHaveBeenCalledTimes(1)
  })

  it('40301 无权限：error 提示，forbiddenMessage 可覆盖', () => {
    handleApiError(new ApiError(ErrorCode.FORBIDDEN, '无权限'), {
      forbiddenMessage: '无权限删除客户',
    })
    expect(h.message.error).toHaveBeenCalledWith('无权限删除客户')
  })

  it('40901 状态冲突：warning，conflictMessage 可覆盖', () => {
    handleApiError(new ApiError(ErrorCode.CONFLICT, '状态冲突'), {
      conflictMessage: '邮箱已被占用',
    })
    expect(h.message.warning).toHaveBeenCalledWith('邮箱已被占用')
  })

  it('42201 业务校验失败：warning 提示后端 message', () => {
    handleApiError(new ApiError(ErrorCode.BIZ_VALIDATION, '报价低于利润红线'))
    expect(h.message.warning).toHaveBeenCalledWith('报价低于利润红线')
  })

  it('42901 频率限制：warning 携带 Retry-After 秒数', () => {
    handleApiError(new ApiError(ErrorCode.RATE_LIMITED, '', undefined, 5000))
    expect(h.message.warning).toHaveBeenCalledWith('操作过于频繁，请 5 秒后重试')
  })

  it('50001 服务内部错误：全局 notification 携带 traceId', () => {
    handleApiError(new ApiError(ErrorCode.INTERNAL, '服务异常', 'trace-abc'))
    expect(h.notification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('trace-abc'),
      }),
    )
  })

  it('50301 依赖不可用：warning 降级提示（不阻塞）', () => {
    handleApiError(new ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, 'LLM 不可用'))
    expect(h.message.warning).toHaveBeenCalledWith('LLM 不可用')
  })

  it('silent：不弹任何提示', () => {
    handleApiError(new ApiError(ErrorCode.INTERNAL, '服务异常'), { silent: true })
    expect(h.notification).not.toHaveBeenCalled()
  })

  it('非 ApiError：归一化并走通用 error 提示', () => {
    const error = handleApiError(new Error('网络中断'))
    expect(error).toBeInstanceOf(ApiError)
    expect(h.message.error).toHaveBeenCalledWith('网络中断')
  })

  it('非 ApiError 且无 message：回退到 fallback', () => {
    handleApiError('boom', { fallback: '自定义兜底' })
    expect(h.message.error).toHaveBeenCalledWith('自定义兜底')
  })
})

describe('parseRetryAfter', () => {
  it('秒数 → 毫秒', () => {
    expect(parseRetryAfter('5')).toBe(5000)
  })

  it('HTTP 日期 → 剩余毫秒（> 0）', () => {
    const future = new Date(Date.now() + 3000).toUTCString()
    expect(parseRetryAfter(future)).toBeGreaterThan(0)
  })

  it('非法值 / 空值 → undefined', () => {
    expect(parseRetryAfter('abc')).toBeUndefined()
    expect(parseRetryAfter(undefined)).toBeUndefined()
    expect(parseRetryAfter('')).toBeUndefined()
  })
})
