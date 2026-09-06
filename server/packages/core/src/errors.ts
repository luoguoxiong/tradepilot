import { ERROR_DEFAULT_MESSAGE, ERROR_HTTP_STATUS, type ErrorCodeValue } from './error-codes.js';

/**
 * 业务异常：service 层统一抛出（后端技术方案 01 §6）。
 * 全局异常过滤器将其映射为统一 envelope（{ code, message, data, traceId }）。
 */
export class BizException extends Error {
  readonly code: ErrorCodeValue;
  readonly httpStatus: number;
  /** 字段级 detail（如 Zod issues、冲突资源信息） */
  readonly extra?: unknown;

  constructor(code: ErrorCodeValue, message?: string, extra?: unknown) {
    super(message ?? ERROR_DEFAULT_MESSAGE[code]);
    this.name = 'BizException';
    this.code = code;
    this.httpStatus = ERROR_HTTP_STATUS[code];
    this.extra = extra;
  }

  static badRequest(message?: string, extra?: unknown): BizException {
    return new BizException(40001, message, extra);
  }
  static unauthorized(message?: string): BizException {
    return new BizException(40101, message);
  }
  static forbidden(message?: string): BizException {
    return new BizException(40301, message);
  }
  static notFound(message?: string): BizException {
    return new BizException(40401, message);
  }
  static conflict(message?: string, extra?: unknown): BizException {
    return new BizException(40901, message, extra);
  }
  static bizValidation(message?: string, extra?: unknown): BizException {
    return new BizException(42201, message, extra);
  }
  static rateLimited(message?: string): BizException {
    return new BizException(42901, message);
  }
  static dependencyUnavailable(message?: string, extra?: unknown): BizException {
    return new BizException(50301, message, extra);
  }
}
