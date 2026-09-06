import {
  Inject,
  Module,
  type MiddlewareConsumer,
  type NestModule,
  type OnModuleDestroy,
} from '@nestjs/common';
import { pinoHttp } from 'pino-http';
import type { Options as PinoHttpOptions } from 'pino-http';
import type { Logger as PinoLogger } from 'pino';
import { EnvService } from '../../config/env.service.js';
import { createRootLogger, PINO_ROOT } from './logger.factory.js';
import { AppLogger } from './app-logger.service.js';
import { RequestContextMiddleware } from '../middleware/request-context.middleware.js';
import { loadEnv } from '../../config/env.js';

/**
 * 日志与请求上下文模块（后端技术方案 01 §4.2/§5）：
 * ① pino-http 中间件（genReqId 生成 trc_ traceId 并写入 x-trace-id 响应头）
 * ② RequestContextMiddleware（traceId → ALS，供全链路读取）
 * 顺序即注册顺序，业务中间件/守卫/拦截器均在 ALS 上下文内执行。
 */
@Module({
  providers: [
    EnvService,
    {
      provide: PINO_ROOT,
      useFactory: () => createRootLogger(loadEnv()),
    },
    AppLogger,
  ],
  exports: [AppLogger, PINO_ROOT],
})
export class LoggingModule implements NestModule, OnModuleDestroy {
  constructor(@Inject(PINO_ROOT) private readonly root: PinoLogger) {}

  configure(consumer: MiddlewareConsumer): void {
    const pinoOptions: PinoHttpOptions = {
      logger: this.root,
      genReqId: (req, res) => {
        const traceId = `trc_${crypto.randomUUID().replaceAll('-', '')}`;
        res.setHeader('x-trace-id', traceId);
        return traceId;
      },
      autoLogging: {
        ignore: (req) => {
          const url = req.url ?? '';
          return (
            url.startsWith('/metrics') || url.startsWith('/healthz') || url.startsWith('/readyz')
          );
        },
      },
    };

    consumer.apply(pinoHttp(pinoOptions), RequestContextMiddleware).forRoutes('*');
  }

  async onModuleDestroy(): Promise<void> {
    // 优雅停机：flush 日志缓冲
    await this.root.flush();
  }
}
