import { Injectable, type LoggerService } from '@nestjs/common';
import type { Logger as PinoLogger } from 'pino';

/**
 * Nest 内置 logger → pino 适配器。
 * 以此作为 NestFactory.create 的 logger（而非 logger: false）：
 * 模块初始化异常必须可见（曾因 logger:false 吞错导致静默 exit(1)）。
 */
@Injectable()
export class NestPinoLogger implements LoggerService {
  constructor(private readonly root: PinoLogger) {}

  log(message: unknown, context?: string): void {
    this.root.info({ context }, String(message));
  }

  error(message: unknown, trace?: string, context?: string): void {
    this.root.error({ context, trace }, String(message));
  }

  warn(message: unknown, context?: string): void {
    this.root.warn({ context }, String(message));
  }

  debug(message: unknown, context?: string): void {
    this.root.debug({ context }, String(message));
  }

  verbose(message: unknown, context?: string): void {
    this.root.trace({ context }, String(message));
  }

  fatal(message: unknown, context?: string): void {
    this.root.fatal({ context }, String(message));
  }
}
