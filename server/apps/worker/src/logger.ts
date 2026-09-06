import pino from 'pino';
import type { WorkerEnv } from '@tradepilot/shared';

/**
 * 根 pino 实例（JSON 结构化，后端技术方案 01 §5）。
 * job 级 traceId 由入队 payload 携带（api→queue→worker 全链串联），M3 接入 TaskRunner 时绑定。
 */
export function createRootLogger(env: WorkerEnv): pino.Logger {
  return pino({
    level: env.LOG_LEVEL,
    base: { app: 'worker', env: env.NODE_ENV, workerIndex: env.WORKER_INDEX },
    redact: {
      paths: ['*.password', '*.token', '*.secret', '*.refreshToken'],
      censor: '[REDACTED]',
    },
  });
}
