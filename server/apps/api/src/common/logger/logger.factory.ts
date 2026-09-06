import pino from 'pino';
import type { ApiEnv } from '@tradepilot/shared';

export const PINO_ROOT = Symbol('PINO_ROOT');

/**
 * 根 pino 实例（JSON 结构化，后端技术方案 01 §5）。
 * 请求级 traceId 由 pino-http genReqId 生成并写入响应头（trc_ 前缀），
 * ContextMiddleware 随后注入 ALS；服务层经 AppLogger 自动带上 traceId/orgId。
 */
export function createRootLogger(env: ApiEnv): pino.Logger {
  return pino({
    level: env.LOG_LEVEL,
    base: { app: 'api', env: env.NODE_ENV },
    redact: {
      // 禁止日志泄露敏感字段（08 §2）
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.token',
        '*.secret',
      ],
      censor: '[REDACTED]',
    },
  });
}
