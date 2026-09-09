import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggingModule } from './common/logger/logging.module.js';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { TransformInterceptor } from './common/interceptors/transform.interceptor.js';
import { MetricsModule } from './common/metrics/metrics.module.js';
import { MetricsInterceptor } from './common/metrics/metrics.interceptor.js';
import { SecurityModule } from './common/security/security.module.js';
import { HealthModule } from './health/health.module.js';
import { DbModule } from './db/db.module.js';
import { RedisModule } from './redis/redis.module.js';
import { AuthModule } from './auth/auth.module.js';
import { OrgModule } from './org/org.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { TasksModule } from './tasks/tasks.module.js';
import { KnowledgeModule } from './knowledge/knowledge.module.js';
import { ApprovalsModule } from './approvals/approvals.module.js';
import { ConversationsModule } from './conversations/conversations.module.js';
import { CustomersModule } from './customers/customers.module.js';

/**
 * API 根模块（后端技术方案 01 §4）。
 * 全局顺序：限流中间件（SecurityModule，08 §4）→ 异常过滤器 → 指标埋点 → envelope 包装；
 * Guard 链由 AuthModule 注册（JwtAuthGuard → RolesGuard，03 §2.2）。
 * 业务模块（org/tasks/knowledge/approvals/...）按里程碑逐个注册。
 */
@Module({
  imports: [
    LoggingModule,
    MetricsModule,
    SecurityModule,
    DbModule,
    RedisModule,
    HealthModule,
    AuthModule,
    OrgModule,
    SettingsModule,
    TasksModule,
    KnowledgeModule,
    ApprovalsModule,
    ConversationsModule,
    CustomersModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
  ],
})
export class AppModule {}
