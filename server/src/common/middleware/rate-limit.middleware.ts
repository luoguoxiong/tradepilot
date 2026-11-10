import type { NextFunction, Request, Response } from 'express';

import { logger } from '../../logger';

/**
 * 登录/注册限流（单实例内存版；多实例部署时须换 Redis 计数器，见 security-and-hardening）。
 * 15 分钟窗口，每 IP 最多 30 次——开发环境友好的阈值，生产可经环境变量收紧。
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 30;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export function authRateLimit(req: Request, res: Response, next: NextFunction): void {
  const key = req.ip ?? 'unknown';
  const now = Date.now();

  // 周期清理过期桶，防 Map 无限增长
  if (buckets.size > 1000) {
    for (const [k, v] of buckets) {
      if (v.resetAt <= now) buckets.delete(k);
    }
  }

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    next();
    return;
  }

  bucket.count += 1;
  if (bucket.count > MAX_ATTEMPTS) {
    logger.warn({ ip: key, path: req.path }, 'auth rate limit exceeded');
    res.status(429).json({
      error: { code: 'RATE_LIMITED', message: 'Too many attempts, try again later' },
    });
    return;
  }
  next();
}
