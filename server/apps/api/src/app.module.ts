import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggingModule } from './common/logger/logging.module.js';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { TransformInterceptor } from './common/interceptors/transform.interceptor.js';
import { MetricsModule } from './common/metrics/metrics.module.js';
import { MetricsInterceptor } from './common/metrics/metrics.interceptor.js';
import { HealthModule } from './health/health.module.js';

/**
 * API 根模块（M1-5 骨架；后端技术方案 01 §4）。
 * 全局顺序：异常过滤器 → 指标埋点（记录真实耗时含包装开销）→ envelope 包装。
 * 业务模块（auth/leads/...）按里程碑逐个注册。
 */
@Module({
  imports: [LoggingModule, MetricsModule, HealthModule],
  providers: [
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
  ],
})
export class AppModule {}
