import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import pinoHttp from 'pino-http';

import { AppModule } from './app.module';
import { getEnv } from './config';
import { logger } from './logger';
import { authRateLimit } from './common/middleware/rate-limit.middleware';

/** 应用工厂：main.ts 与集成测试共用同一装配 */
export async function createApp(): Promise<INestApplication> {
  const env = getEnv();
  if (!env.APP_ENCRYPTION_KEY) {
    logger.warn('APP_ENCRYPTION_KEY 未配置 —— integrations Key 加密功能不可用');
  }

  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  app.use('/api/auth', authRateLimit);
  app.use(
    pinoHttp({
      logger,
      genReqId: () => randomUUID(),
      autoLogging: { ignore: (req) => req.url === '/api/health' },
    }) as never,
  );
  return app;
}
