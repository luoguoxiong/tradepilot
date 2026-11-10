import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import pinoHttp from 'pino-http';
import { AppModule } from './app.module';
import { getEnv } from './config';
import { logger } from './logger';
import { authRateLimit } from './common/middleware/rate-limit.middleware';

async function bootstrap(): Promise<void> {
  const env = getEnv();
  if (!env.APP_ENCRYPTION_KEY) {
    logger.warn('APP_ENCRYPTION_KEY 未配置 —— integrations Key 加密功能将在阶段 5 前要求配置');
  }

  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  app.use('/api/auth', authRateLimit); // 登录/注册限流（单实例内存版）
  app.use(
    pinoHttp({
      logger,
      genReqId: () => randomUUID(),
      autoLogging: { ignore: (req) => req.url === '/api/health' }, // 健康检查不刷日志
    }) as never,
  );

  await app.listen(env.PORT);
  logger.info({ port: env.PORT, health: `http://127.0.0.1:${env.PORT}/api/health` }, 'TradePilot API started');
}

void bootstrap();
