import { Module } from '@nestjs/common';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  register,
  type CounterConfiguration,
  type GaugeConfiguration,
  type HistogramConfiguration,
} from 'prom-client';
import { MetricsController } from './metrics.controller.js';
import { MetricsService } from './metrics.service.js';
import { PROM_REGISTRY } from './metrics.tokens.js';

/**
 * Prometheus 指标模块（后端技术方案 09 §6.2 骨架）。
 * HTTP qps/p95/错误率 → M6 收口时补充队列/任务/LLM/SSE 指标族。
 * OTel SDK（trace 采样）在 M6 部署里程碑接入，避免 M1 引入过重依赖。
 */
@Module({
  controllers: [MetricsController],
  providers: [
    {
      provide: PROM_REGISTRY,
      useValue: register,
    },
    MetricsService,
    {
      provide: 'HTTP_REQUEST_DURATION',
      useFactory: (registry: typeof register): Histogram<string> => {
        const config: HistogramConfiguration<string> = {
          name: 'tradepilot_http_request_duration_seconds',
          help: 'HTTP 请求耗时（秒）',
          labelNames: ['method', 'route', 'status'] as const,
          buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 3, 10],
          registers: [registry],
        };
        return new Histogram(config);
      },
      inject: [PROM_REGISTRY],
    },
    {
      provide: 'HTTP_REQUEST_TOTAL',
      useFactory: (registry: typeof register): Counter<string> => {
        const config: CounterConfiguration<string> = {
          name: 'tradepilot_http_requests_total',
          help: 'HTTP 请求总数',
          labelNames: ['method', 'route', 'status'] as const,
          registers: [registry],
        };
        return new Counter(config);
      },
      inject: [PROM_REGISTRY],
    },
    {
      provide: 'HTTP_IN_FLIGHT',
      useFactory: (registry: typeof register): Gauge<string> => {
        const config: GaugeConfiguration<string> = {
          name: 'tradepilot_http_in_flight_requests',
          help: '进行中的 HTTP 请求数',
          registers: [registry],
        };
        return new Gauge(config);
      },
      inject: [PROM_REGISTRY],
    },
    {
      provide: 'OTEL_READY',
      useFactory: (): boolean => {
        // M6 接入 @opentelemetry/sdk-node（HTTP 自动埋点 + 采样 10%）；M1 仅标记占位
        collectDefaultMetrics({ register });
        return false;
      },
      inject: [PROM_REGISTRY],
    },
  ],
  exports: [MetricsService, PROM_REGISTRY],
})
export class MetricsModule {
  // OTEL_READY 工厂在实例化时已注册默认指标采集（process/GC）；构造器无需注入
}
