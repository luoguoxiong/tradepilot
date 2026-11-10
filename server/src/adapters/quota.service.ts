import { Inject, Injectable } from '@nestjs/common';

import { RedisService } from '../redis/redis.service';
import { AdapterError } from './types';

/**
 * 三方 API 日配额（Redis 计数，架构 §3.2 成本控制）。
 * 只约束 Real Adapter（Mock 无成本不计数）。
 */
@Injectable()
export class QuotaService {
  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  /** 计数并校验；超限抛 QUOTA_EXCEEDED */
  async consume(provider: string, userId: string, calls = 1): Promise<void> {
    const limit = this.limitFor(provider);
    if (limit <= 0) return; // 未配置配额限制 = 不限制
    await this.redis.ensureConnected();
    const day = new Date().toISOString().slice(0, 10);
    const key = `quota:${provider}:${userId}:${day}`;
    const count = await this.redis.incrby(key, calls);
    if (count === calls) {
      await this.redis.expire(key, 60 * 60 * 48); // 48h 兜底过期
    }
    if (count > limit) {
      throw new AdapterError('QUOTA_EXCEEDED', `${provider} 日配额已用尽（${limit}/天），明日恢复或调大 ADAPTER_DAILY_QUOTA_*`);
    }
  }

  private limitFor(provider: string): number {
    const env = process.env;
    const raw =
      provider === 'serper'
        ? env.ADAPTER_DAILY_QUOTA_SERPER
        : provider === 'apollo'
          ? env.ADAPTER_DAILY_QUOTA_APOLLO
          : env.ADAPTER_DAILY_QUOTA_CUSTOMS;
    const n = Number(raw ?? 0);
    return Number.isFinite(n) ? n : 0;
  }
}
