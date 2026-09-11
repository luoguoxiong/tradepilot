import { defineConfig } from 'vitest/config';

/**
 * API 测试配置：
 * - setupFiles 注入全局 crypto 兜底（token.service / logging.module 依赖）；
 * - fileParallelism=false：集成测试共享 PG/Redis，串行化消除跨文件竞态。
 */
export default defineConfig({
  test: {
    setupFiles: ['./test/setup/crypto.ts', './test/setup/providers.ts'],
    fileParallelism: false,
    // 真实 LLM 结构化输出（含自纠正重试）可达数十秒，放宽全局超时；
    // 迁移前 mock provider 调用为毫秒级，5s 默认值已不再适用。
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
