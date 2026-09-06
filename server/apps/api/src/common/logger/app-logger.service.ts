import { Inject, Injectable, type LoggerService as NestLoggerService } from '@nestjs/common';
import type { Logger as PinoLogger } from 'pino';
import { PINO_ROOT } from './logger.factory.js';
import { currentTraceId, getContext } from '../../context/request-context.js';

/**
 * pino 日志封装（后端技术方案 01 §5）：
 * 字段 traceId / orgId / taskId? / employeeId? / module / msg；
 * 禁止打印凭据、邮箱明文、token（redact 兜底在 logger.factory）。
 * traceId 与 orgId 从 ALS 上下文自动绑定。
 */
export interface LogContext {
  taskId?: string;
  employeeId?: string;
  module?: string;
  [key: string]: unknown;
}

type Level = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

@Injectable()
export class AppLogger implements NestLoggerService {
  constructor(@Inject(PINO_ROOT) private readonly root: PinoLogger) {}

  private child(bindings: LogContext = {}): PinoLogger {
    const ctx = getContext();
    return this.root.child({
      traceId: currentTraceId() || undefined,
      orgId: ctx?.orgId,
      userId: ctx?.userId,
      ...bindings,
    });
  }

  log(message: unknown, context?: LogContext | string): void {
    this.write('info', message, context);
  }
  info(message: unknown, context?: LogContext | string): void {
    this.write('info', message, context);
  }
  error(message: unknown, context?: LogContext | string): void {
    this.write('error', message, context);
  }
  warn(message: unknown, context?: LogContext | string): void {
    this.write('warn', message, context);
  }
  debug(message: unknown, context?: LogContext | string): void {
    this.write('debug', message, context);
  }
  verbose(message: unknown, context?: LogContext | string): void {
    this.write('trace', message, context);
  }
  fatal(message: unknown, context?: LogContext | string): void {
    this.write('fatal', message, context);
  }

  private write(level: Level, message: unknown, context?: LogContext | string): void {
    const bindings: LogContext =
      typeof context === 'string' ? { module: context } : (context ?? {});
    const logger = this.child(bindings);
    if (message instanceof Error) {
      logger[level]({ err: message }, message.message);
    } else {
      logger[level](message);
    }
  }
}
