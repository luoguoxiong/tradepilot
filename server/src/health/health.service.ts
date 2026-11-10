import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

export interface HealthReport {
  status: 'ok' | 'degraded' | 'error';
  db: 'up' | 'down';
  redis: 'up' | 'down';
  timestamp: string;
}

@Injectable()
export class HealthService {
  constructor(
    // 注：tsx/esbuild 不支持 emitDecoratorMetadata，注入必须显式 @Inject
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  async check(): Promise<HealthReport> {
    const db = await this.checkDb();
    const redis = await this.checkRedis();
    const status: HealthReport['status'] =
      db === 'up' ? (redis === 'up' ? 'ok' : 'degraded') : 'error';
    return { status, db, redis, timestamp: new Date().toISOString() };
  }

  private async checkDb(): Promise<'up' | 'down'> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkRedis(): Promise<'up' | 'down'> {
    try {
      await this.redis.ensureConnected();
      const reply = await this.redis.ping();
      return reply === 'PONG' ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }
}
