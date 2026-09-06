import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit 配置（后端技术方案 02 §2）：
 * 生成产物在 src/migrations/（SQL 纳入 git）；执行统一走 src/migrate.ts（先 extensions → drizzle 产物 → manual）。
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './src/migrations',
  strict: true,
  verbose: false,
  dbCredentials: {
    // 生成（generate）不连库；migrate 由 src/migrate.ts 接管，此处仅为 CLI 兼容占位
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/tradepilot',
  },
});
