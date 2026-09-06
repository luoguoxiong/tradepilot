/**
 * 统一业务错误码（接口规范 §2.5，与 server/packages/core/src/error-codes.ts 逐值对齐）。
 * 前端行为映射见技术方案 03 §4。
 */
export const ErrorCode = {
  /** 成功 */
  OK: 0,
  /** 参数错误 */
  BAD_REQUEST: 40001,
  /** 未认证 / Token 失效 */
  UNAUTHORIZED: 40101,
  /** 无权限（含数据范围限制） */
  FORBIDDEN: 40301,
  /** 资源不存在 */
  NOT_FOUND: 40401,
  /** 状态冲突（重复提交、非法状态流转） */
  CONFLICT: 40901,
  /** 业务校验失败（如报价低于利润红线） */
  BIZ_VALIDATION: 42201,
  /** 频率限制 */
  RATE_LIMITED: 42901,
  /** 服务内部错误 */
  INTERNAL: 50001,
  /** 依赖服务不可用（LLM / 邮箱 / 外部数据源） */
  DEPENDENCY_UNAVAILABLE: 50301,
} as const

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode]
