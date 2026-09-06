import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';
import { createRootLogger } from './common/logger/logger.factory.js';
import { NestPinoLogger } from './common/logger/nest-pino.logger.js';

/**
 * API 启动入口（后端技术方案 00 §4 / 01）：
 * env fail-fast → root logger → Nest app（全局前缀 /api/v1）→ SIGTERM 优雅停机。
 */
async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const root = createRootLogger(env);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Nest 生命周期日志（含模块初始化异常）转发到 pino；请求日志由 pino-http 承担
    logger: new NestPinoLogger(root),
  });

  // health/metrics 挂根路径（09 §2：K8s 探针与 Prometheus 抓取约定，不带 /api/v1 前缀）
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz', 'metrics'] });
  app.enableShutdownHooks();
  app.useBodyParser('json', { limit: '5mb' });

  const port = env.API_PORT;
  await app.listen(port, '0.0.0.0');
  root.info({ port, env: env.NODE_ENV }, `API 已启动: http://0.0.0.0:${port}/api/v1`);
}

bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('API 启动失败:', err);
  process.exit(1);
});
