import { defineConfig } from 'vitest/config';

/**
 * Worker 测试配置（集成测试，连真实 PG/Redis/MinIO）：
 * - setupFiles 注入全局 crypto 兜底（@langchain/core rng 依赖）；
 * - fileParallelism=false：集成测试共享同一 PG/Redis 实例，并发跑会互相截断/抢占
 *   （各文件 afterAll 全表清理），串行化消除跨文件 DB 竞态。
 */
export default defineConfig({
  test: {
    setupFiles: ['./test/setup/crypto.ts'],
    fileParallelism: false,
  },
});
