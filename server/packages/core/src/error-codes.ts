/**
 * 统一业务错误码与 HTTP 状态映射（接口总览 §2.5）。
 * 禁止在业务代码中使用魔法数字，一律引用本表。
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
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ERROR_HTTP_STATUS: Record<ErrorCodeValue, number> = {
  [ErrorCode.OK]: 200,
  [ErrorCode.BAD_REQUEST]: 400,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.BIZ_VALIDATION]: 422,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.INTERNAL]: 500,
  [ErrorCode.DEPENDENCY_UNAVAILABLE]: 503,
};

export const ERROR_DEFAULT_MESSAGE: Record<ErrorCodeValue, string> = {
  [ErrorCode.OK]: 'ok',
  [ErrorCode.BAD_REQUEST]: '参数错误',
  [ErrorCode.UNAUTHORIZED]: '未认证或登录已失效',
  [ErrorCode.FORBIDDEN]: '无权限执行该操作',
  [ErrorCode.NOT_FOUND]: '资源不存在',
  [ErrorCode.CONFLICT]: '状态冲突',
  [ErrorCode.BIZ_VALIDATION]: '业务校验失败',
  [ErrorCode.RATE_LIMITED]: '请求过于频繁',
  [ErrorCode.INTERNAL]: '服务内部错误',
  [ErrorCode.DEPENDENCY_UNAVAILABLE]: '依赖服务暂不可用',
};
