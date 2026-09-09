import { defineConfig } from 'vitest/config';

/**
 * API 测试配置：
 * - setupFiles 注入全局 crypto 兜底（token.service / logging.module 依赖）；
 * - fileParallelism=false：集成测试共享 PG/Redis，串行化消除跨文件竞态。
 */
export default defineConfig({
  test: {
    setupFiles: ['./test/setup/crypto.ts'],
    fileParallelism: false,
  },
});
