import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import type { Response } from 'express';
import { EnvService } from '../config/env.service.js';
import { RawResponse } from '../common/decorators/raw-response.decorator.js';

/**
 * 健康检查（后端技术方案 09 §2）：
 * - /healthz 进程存活（liveness，不探依赖）
 * - /readyz 依赖就绪：DB/Redis 连通 + 迁移版本匹配（迁移版本校验 M2 数据层落地后接入）
 * K8s readiness/liveness 对应；失败返回 503。
 */
@Controller()
export class HealthController {
  // @Inject 强制 EnvService 保持运行时导入（同 TransformInterceptor，保证 DI 元数据）
  constructor(@Inject(EnvService) private readonly env: EnvService) {}

  @Get('healthz')
  @RawResponse()
  healthz(@Res() res: Response): void {
    res.status(HttpStatus.OK).json({ status: 'ok' });
  }

  @Get('readyz')
  @RawResponse()
  async readyz(@Res() res: Response): Promise<void> {
    const checks = {
      db: await this.checkDb(),
      redis: await this.checkRedis(),
    };
    const ready = checks.db.ok && checks.redis.ok;
    res.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json({
      status: ready ? 'ok' : 'degraded',
      checks,
    });
  }

  private async checkDb(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    const started = Date.now();
    const client = new Client({
      connectionString: this.env.env.DATABASE_URL,
      connectionTimeoutMillis: 2000,
    });
    try {
      await client.connect();
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  private async checkRedis(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    const started = Date.now();
    const redis = new Redis(this.env.env.REDIS_URL, {
      connectTimeout: 2000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      lazyConnect: true,
    });
    try {
      await redis.connect();
      const pong = await redis.ping();
      return { ok: pong === 'PONG', latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      redis.disconnect();
    }
  }
}
