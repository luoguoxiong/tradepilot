import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { REDIS } from '../../redis/redis.module.js';

/**
 * 接口限流中间件（M4 #11 安全基线，后端技术方案 08 §4）：
 * Redis 固定窗口（60s）按 IP 计数，超限直接 42901 envelope（绕过管线直接写响应）。
 * - 默认 600 req/min/IP（env RATE_LIMIT_PER_MINUTE 可调，0 = 关闭）；
 * - 探针/指标路径（healthz/readyz/metrics）豁免（K8s 抓取高频，非业务面）；
 * - Redis 故障 fail-open（限流不可用不应放大故障面）。
 */
const WINDOW_SECONDS = 60;
const EXEMPT_PREFIXES = ['/healthz', '/readyz', '/metrics'];

function resolveLimit(): number {
  const raw = Number(process.env['RATE_LIMIT_PER_MINUTE'] ?? '');
  return Number.isFinite(raw) && raw >= 0 ? raw : 600;
}

@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async use(req: Request & { originalUrl?: string }, res: Response, next: NextFunction) {
    const limit = resolveLimit();
    const path = req.originalUrl ?? req.url ?? '';
    if (limit <= 0 || EXEMPT_PREFIXES.some((p) => path.startsWith(p))) {
      next();
      return;
    }
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    // 固定窗口 key：rl:{ip}:{minuteIndex}
    const minuteIndex = Math.floor(Date.now() / (WINDOW_SECONDS * 1000));
    const key = `rl:${ip}:${minuteIndex}`;
    try {
      const used = await this.redis.incr(key);
      if (used === 1) {
        await this.redis.expire(key, WINDOW_SECONDS + 5);
      }
      if (used > limit) {
        res.status(429).json({
          code: 42901,
          message: '请求过于频繁（超出限流阈值）',
          data: null,
          traceId: '',
        });
        return;
      }
    } catch {
      // fail-open：Redis 异常不阻断业务
    }
    next();
  }
}
