import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { map, type Observable } from 'rxjs';
import type { Envelope } from '@tradepilot/shared';
import { currentTraceId } from '../../context/request-context.js';
import { RAW_RESPONSE_KEY } from '../decorators/raw-response.decorator.js';

/**
 * 成功响应包装（01 §4.1）：{ code: 0, message: 'ok', data, traceId }。
 * 标注 @RawResponse() 的处理器（如 /metrics）跳过包装。
 */
@Injectable()
export class TransformInterceptor implements NestInterceptor {
  // @Inject 强制 Reflector 保持运行时导入（emitDecoratorMetadata 在 verbatimModuleSyntax 下省略 type-only 导入的元数据）
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isRaw =
      this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;

    if (isRaw) {
      return next.handle();
    }

    return next.handle().pipe(
      map((data: unknown) => {
        const body: Envelope<unknown> = {
          code: 0,
          message: 'ok',
          data: data ?? null,
          traceId: currentTraceId(),
        };
        // traceId 响应头已在 pino genReqId 设置；此处兜底
        const res = context.switchToHttp().getResponse<Response>();
        if (!res.getHeader('x-trace-id')) {
          res.setHeader('x-trace-id', body.traceId);
        }
        return body;
      }),
    );
  }
}
