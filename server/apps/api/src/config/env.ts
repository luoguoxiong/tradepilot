import { apiEnvSchema, parseEnv, type ApiEnv } from '@tradepilot/shared';

/**
 * 环境变量加载（fail-fast，后端技术方案 01 §4.5 / 09 §4）。
 * main.ts 与 EnvService 共用本函数；解析结果进程内 memoize，保证只解析一次。
 */
let cached: ApiEnv | null = null;

export function loadEnv(): ApiEnv {
  if (cached === null) {
    cached = parseEnv(apiEnvSchema);
  }
  return cached;
}
