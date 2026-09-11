import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';
import { loadLocalDotEnv } from './config/local-env.js';
import { createRootLogger } from './common/logger/logger.factory.js';
import { NestPinoLogger } from './common/logger/nest-pino.logger.js';
import { DB } from './db/db.module.js';
import {
  configureObjectStorage,
  createEmbeddingProvider,
  createS3Storage,
  setEmbeddingProviderFactory,
} from '@tradepilot/integrations';
import type { Db } from '@tradepilot/db';
import {
  EMBEDDING_FIELD_DEFAULTS,
  resolveActiveModel,
  toEmbeddingProviderConfig,
} from '@tradepilot/runtime';

// 入口先补齐本地 .env（仅补缺失键，不覆盖 k8s/CI/shell 已注入变量）
loadLocalDotEnv();

/**
 * API 启动入口（后端技术方案 00 §4 / 01）：
 * env fail-fast → root logger → Nest app（全局前缀 /api/v1）→ SIGTERM 优雅停机。
 */
async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const root = createRootLogger(env);

  // M4 #7/#8：S3 对象存储（知识原文）进程级注入（07 §2）
  configureObjectStorage(
    createS3Storage({
      endpoint: env.S3_ENDPOINT,
      bucket: env.S3_BUCKET,
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    }),
  );

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Nest 生命周期日志（含模块初始化异常）转发到 pino；请求日志由 pino-http 承担
    logger: new NestPinoLogger(root),
  });

  // M4 #7 + 16 FR-10 扩展：嵌入服务（检索 query 向量化）按 org 解析
  // 「系统设置 → AI 模型配置」选用的 embedding 模型（仅 admin 可维护，不再读环境变量）；
  // 未配置选用模型时明确报错（不再回落 mock）。
  const db = app.get<Db>(DB);
  setEmbeddingProviderFactory(async (orgId) => {
    const active =
      orgId === undefined
        ? null
        : await resolveActiveModel(db, orgId, 'embedding', env.ENCRYPTION_KEY).catch(
            (err: unknown) => {
              root.warn(
                { orgId, err: err instanceof Error ? err.message : String(err) },
                '读取 embedding 模型配置失败，按未配置处理',
              );
              return null;
            },
          );
    if (!active) {
      throw new Error(
        `org=${orgId ?? '-'} 未配置向量模型：请在「系统设置 → AI 模型配置」中配置并选用 embedding 模型`,
      );
    }
    return createEmbeddingProvider(toEmbeddingProviderConfig(active, EMBEDDING_FIELD_DEFAULTS));
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
