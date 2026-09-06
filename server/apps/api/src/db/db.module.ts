import { Global, Inject, Module, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { closeDb, createDb, type Db } from '@tradepilot/db';
import { EnvService } from '../config/env.service.js';

/** DI token：drizzle 实例（api 进程独立连接池，02 §3） */
export const DB = Symbol('DB');

const dbProvider: Provider = {
  provide: DB,
  inject: [EnvService],
  useFactory: (env: EnvService) => createDb(env.env.DATABASE_URL),
};

/**
 * 数据访问模块（后端技术方案 02）：
 * 全局提供 Db；RLS 会话由业务层 withOrg 打开，模块只管连接生命周期。
 */
@Global()
@Module({
  providers: [EnvService, dbProvider],
  exports: [DB, EnvService],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Db) {}

  async onApplicationShutdown(): Promise<void> {
    await closeDb(this.db);
  }
}
