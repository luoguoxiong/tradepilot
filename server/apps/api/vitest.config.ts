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
    // 实测慢速推理型模型单次调用约 30s，用例常含 2 次以上串行调用 + 自纠正重试，
    // 60s 会以「Test timed out」误判为失败，故按最坏 3 次调用放宽到 180s。
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
