import { ElMessage, ElNotification } from 'element-plus'

import { ErrorCode } from '@/api/error-codes'
import { ApiError } from '@/api/http'
import { i18n } from '@/locales'

/**
 * 统一错误码管道（前端技术方案 03 §4 / 联调计划表 #1）：
 * code → UI 行为单一事实源，axios 与 SSE 消费方共用，禁止页面各自 switch 错误码。
 *
 * | code   | 行为                                                         |
 * | ------ | ------------------------------------------------------------ |
 * | 40001  | 参数错误：warning（表单场景可 onBadRequest 内联处理并吞掉提示） |
 * | 40101  | 未认证：静默（http 层已清会话，路由守卫接管跳登录）           |
 * | 40301  | 无权限：error 提示；列表场景由消费方渲染空态                  |
 * | 40401  | 资源不存在：warning（详情页可跳 404 空态）                    |
 * | 40901  | 状态冲突：warning（乐观更新回滚由消费方在 onError 完成）      |
 * | 42201  | 业务校验失败：warning（中断提交、保留表单）                   |
 * | 42901  | 频率限制：warning + Retry-After 秒数                          |
 * | 50001  | 服务内部错误：全局 notification + traceId（便于客服排查）      |
 * | 50301  | 依赖不可用：warning（LLM/邮箱降级提示，不阻塞其余区块）        |
 */
export interface HandleApiErrorOptions {
  /** 兜底文案（错误无 message 或非 ApiError 时） */
  fallback?: string
  /** 覆盖 40301 文案（如模块化「无权限删除客户」） */
  forbiddenMessage?: string
  /** 覆盖 40901 文案（如「邮箱已被占用」） */
  conflictMessage?: string
  /** 40001：表单内联处理；返回 true 表示已处理，不再弹提示（可读 error.details.issues 做字段映射） */
  onBadRequest?: (error: ApiError) => boolean
  /** 静默：不弹任何提示，仅返回归一化错误（40101 恒定静默） */
  silent?: boolean
}

/** 非 ApiError 归一化（保留原始 message，供调用方按 code 兜底） */
function toApiError(error: unknown, fallback?: string): ApiError {
  if (error instanceof ApiError) return error
  const message = error instanceof Error && error.message ? error.message : ''
  return new ApiError(
    ErrorCode.INTERNAL,
    message || fallback || i18n.global.t('common.operationFailed'),
  )
}

/**
 * 错误码 → UI 行为统一入口。
 * @returns 归一化后的 ApiError（调用方可继续读取 code / traceId / retryAfterMs）
 */
export function handleApiError(error: unknown, options: HandleApiErrorOptions = {}): ApiError {
  const t = i18n.global.t

  // 非 ApiError（本地抛错 / 网络中断等）：保留原始语义，走通用 error 提示
  if (!(error instanceof ApiError)) {
    if (!options.silent) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : options.fallback || t('common.operationFailed')
      ElMessage.error(message)
    }
    return toApiError(error, options.fallback)
  }

  if (options.silent || error.code === ErrorCode.UNAUTHORIZED) {
    // 40101 会话已在 http 层清理并触发守卫跳登录，此处静默避免重复提示（03 §4）
    return error
  }

  switch (error.code) {
    case ErrorCode.BAD_REQUEST:
      if (options.onBadRequest?.(error)) return error
      ElMessage.warning(error.message || options.fallback || t('errors.badRequest'))
      return error

    case ErrorCode.FORBIDDEN:
      ElMessage.error(options.forbiddenMessage || error.message || t('errors.forbidden'))
      return error

    case ErrorCode.NOT_FOUND:
      ElMessage.warning(error.message || t('errors.notFound'))
      return error

    case ErrorCode.CONFLICT:
      ElMessage.warning(options.conflictMessage || error.message || t('errors.conflict'))
      return error

    case ErrorCode.BIZ_VALIDATION:
      ElMessage.warning(error.message || options.fallback || t('errors.bizValidation'))
      return error

    case ErrorCode.RATE_LIMITED: {
      const seconds = error.retryAfterMs ? Math.ceil(error.retryAfterMs / 1000) : 0
      ElMessage.warning(
        seconds > 0
          ? t('errors.rateLimited', { seconds })
          : error.message || t('errors.rateLimitedGeneric'),
      )
      return error
    }

    case ErrorCode.DEPENDENCY_UNAVAILABLE:
      ElMessage.warning(error.message || options.fallback || t('errors.dependencyUnavailable'))
      return error

    case ErrorCode.INTERNAL:
    default: {
      const base = error.message || options.fallback || t('errors.internal')
      ElNotification({
        title: t('errors.internalTitle'),
        message: error.traceId
          ? t('errors.internalWithTrace', { message: base, traceId: error.traceId })
          : base,
        type: 'error',
        duration: 6000,
      })
      return error
    }
  }
}
