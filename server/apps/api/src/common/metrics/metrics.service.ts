import { Inject, Injectable } from '@nestjs/common';
import type { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { PROM_REGISTRY } from './metrics.tokens.js';

/**
 * HTTP 指标记录服务（后端技术方案 09 §6.2）。
 * MetricsInterceptor 在请求前后调用；queue/task/LLM 指标族 M6 收口时扩展。
 */
@Injectable()
export class MetricsService {
  constructor(
    @Inject(PROM_REGISTRY) public readonly registry: Registry,
    @Inject('HTTP_REQUEST_DURATION') private readonly duration: Histogram<string>,
    @Inject('HTTP_REQUEST_TOTAL') private readonly total: Counter<string>,
    @Inject('HTTP_IN_FLIGHT') private readonly inFlight: Gauge<string>,
  ) {}

  /** 请求进入：in-flight +1，返回 end() 在响应结束时调用 */
  startRequest(method: string, route: string): (status: number) => void {
    this.inFlight.inc();
    const end = this.duration.startTimer({ method, route });
    return (status: number) => {
      end({ status: String(status) });
      this.total.inc({ method, route, status: String(status) });
      this.inFlight.dec();
    };
  }
}
