import { Global, Inject, Module, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { Redis } from 'ioredis';
import { EnvService } from '../config/env.service.js';
/** DI token：ioredis 客户端（限流 / refresh token 撤销 / 停用标记，03 §1.2） */
export const REDIS = Symbol('REDIS');

const redisProvider: Provider = {
  provide: REDIS,
  inject: [EnvService],
  useFactory: (env: EnvService): Redis =>
    new Redis(env.env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false }),
};

/** Redis 连接（限流计数 / refresh 撤销 / 停用标记共用）。EnvService 由全局 DbModule 导出 */
@Global()
@Module({
  providers: [redisProvider],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
