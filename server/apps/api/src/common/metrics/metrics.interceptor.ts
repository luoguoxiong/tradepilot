import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { tap, type Observable } from 'rxjs';
import { MetricsService } from './metrics.service.js';

/**
 * HTTP 指标埋点（09 §6.2 HTTP 指标族：qps/p95/错误率/in-flight）。
 * route 用路由模板（/tasks/:id）而非原始 URL，避免 label 基数爆炸；
 * 404 未匹配路由不经过拦截器（filter 兜底），不计入。
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  // @Inject 强制 DI 元数据（verbatimModuleSyntax 下 type-only 导入不产生 design:paramtypes）
  constructor(@Inject(MetricsService) private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType<'http'>() !== 'http') {
      return next.handle();
    }

    const req = context
      .switchToHttp()
      .getRequest<Request & { route?: { path?: string }; baseUrl?: string }>();
    const route = req.route?.path ?? req.baseUrl ?? 'unmatched';
    if (route === 'unmatched') {
      return next.handle();
    }

    const end = this.metrics.startRequest(req.method, route);
    return next.handle().pipe(
      tap({
        next: () => end(context.switchToHttp().getResponse().statusCode),
        error: () => end(context.switchToHttp().getResponse().statusCode ?? 500),
      }),
    );
  }
}
