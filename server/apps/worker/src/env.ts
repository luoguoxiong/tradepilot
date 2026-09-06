import { parseEnv, workerEnvSchema, type WorkerEnv } from '@tradepilot/shared';

/**
 * 环境变量加载（fail-fast，09 §4）。解析结果进程内 memoize，保证只解析一次。
 */
let cached: WorkerEnv | null = null;

export function loadEnv(): WorkerEnv {
  if (cached === null) {
    cached = parseEnv(workerEnvSchema);
  }
  return cached;
}
