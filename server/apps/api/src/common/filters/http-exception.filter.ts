import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Logger } from 'pino';
import {
  BizException,
  ERROR_DEFAULT_MESSAGE,
  ERROR_HTTP_STATUS,
  ErrorCode,
  type ErrorCodeValue,
} from '@tradepilot/core';
import type { Envelope } from '@tradepilot/shared';
import { currentTraceId } from '../../context/request-context.js';
import { PINO_ROOT } from '../logger/logger.factory.js';
import { Inject } from '@nestjs/common';

/**
 * 全局唯一异常出口（后端技术方案 01 §4.1）：
 * 一切响应都是 envelope { code, message, data, traceId }。
 * - BizException        → 业务错误码（接口总览 §2.5）
 * - Nest HttpException  → 按状态码映射（404 路由未命中 → 40401 等）
 * - ZodError            → 40001 + 字段级 detail
 * - 未知异常            → 50001 + error 日志（不向客户端泄露堆栈）
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(@Inject(PINO_ROOT) private readonly root: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const traceId = currentTraceId();

    let status: number;
    let body: Envelope<unknown>;

    if (exception instanceof BizException) {
      status = exception.httpStatus;
      body = {
        code: exception.code,
        message: exception.message || ERROR_DEFAULT_MESSAGE[exception.code],
        data: exception.extra ?? null,
        traceId,
      };
      this.root.warn({ traceId, code: exception.code }, `业务异常: ${body.message}`);
    } else if (exception instanceof HttpException) {
      const httpStatus = exception.getStatus();
      const mapped = this.mapHttpStatus(httpStatus);
      const response = exception.getResponse();
      const rawMessage =
        typeof response === 'string' ? response : (response as { message?: unknown }).message;
      status = httpStatus;
      body = {
        code: mapped,
        message:
          typeof rawMessage === 'string' && rawMessage.length > 0
            ? rawMessage
            : ERROR_DEFAULT_MESSAGE[mapped],
        data: null,
        traceId,
      };
      this.root.warn({ traceId }, `HTTP 异常: ${httpStatus}`);
    } else if (
      typeof exception === 'object' &&
      exception !== null &&
      'issues' in exception &&
      Array.isArray((exception as { issues: unknown[] }).issues)
    ) {
      // ZodError（未经过 ZodValidationPipe 的场景）
      status = ERROR_HTTP_STATUS[ErrorCode.BAD_REQUEST];
      body = {
        code: ErrorCode.BAD_REQUEST,
        message: '参数错误',
        data: (exception as { issues: unknown }).issues,
        traceId,
      };
      this.root.warn({ traceId }, '参数校验失败(ZodError)');
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      body = {
        code: ErrorCode.INTERNAL,
        message: ERROR_DEFAULT_MESSAGE[ErrorCode.INTERNAL],
        data: null,
        traceId,
      };
      this.root.error(
        { traceId, err: exception instanceof Error ? exception : String(exception) },
        '未捕获异常',
      );
    }

    res.status(status).json(body);
  }

  private mapHttpStatus(status: number): ErrorCodeValue {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ErrorCode.BAD_REQUEST;
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ErrorCode.CONFLICT;
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return ErrorCode.BIZ_VALIDATION;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.RATE_LIMITED;
      case HttpStatus.SERVICE_UNAVAILABLE:
        return ErrorCode.DEPENDENCY_UNAVAILABLE;
      default:
        return status >= 500 ? ErrorCode.INTERNAL : ErrorCode.BAD_REQUEST;
    }
  }
}
