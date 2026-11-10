import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { getEnv } from '../config';
import { PrismaService } from '../prisma/prisma.service';

export interface HealthReport {
  status: 'ok' | 'degraded' | 'error';
  db: 'up' | 'down';
  redis: 'up' | 'down';
  timestamp: string;
}

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    // 注：tsx/esbuild 不支持 emitDecoratorMetadata，注入必须显式 @Inject(Token)
    this.redis = new Redis(getEnv().REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
  }

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
      if (this.redis.status === 'wait' || this.redis.status === 'end' || this.redis.status === 'close') {
        await this.redis.connect(); // lazyConnect：首次/断开后需显式建连
      }
      const reply = await this.redis.ping();
      return reply === 'PONG' ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }
}
