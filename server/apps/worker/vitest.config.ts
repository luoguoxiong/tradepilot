import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // full-chain 与 scheduler 两个集成 spec 共用同一 PG；Dispatcher/FollowUpScanner
    // 为跨租户扫描，并行运行会互扫对方用例数据导致计数错乱 —— 必须串行
    fileParallelism: false,
  },
});
