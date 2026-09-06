import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { runWithContext } from '../../context/request-context.js';

/**
 * 请求上下文中间件：将 pino-http genReqId 生成的 traceId 注入 ALS，
 * 供后续 Guard/Service/Repository 与日志全链路读取（01 §4.2）。
 * 执行顺序：pino 中间件（LoggingModule 先注册）→ 本中间件 → 业务。
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const rawId = (req as Request & { id?: unknown }).id;
    const traceId = typeof rawId === 'string' && rawId.length > 0 ? rawId : 'trc_unknown';
    runWithContext({ traceId }, () => next());
  }
}
