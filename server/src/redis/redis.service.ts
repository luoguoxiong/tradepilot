import { Injectable } from '@nestjs/common';
import Redis from 'ioredis';

import { getEnv } from '../config';

/**
 * 共享 Redis 客户端（应用内配额计数、健康检查等；BullMQ 自行管理连接）。
 * lazyConnect：首次命令前显式建连，避免离线命令报错。
 */
@Injectable()
export class RedisService extends Redis {
  constructor() {
    super(getEnv().REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
  }

  async ensureConnected(): Promise<void> {
    if (this.status === 'wait' || this.status === 'end' || this.status === 'close') {
      await this.connect();
    }
  }
}
