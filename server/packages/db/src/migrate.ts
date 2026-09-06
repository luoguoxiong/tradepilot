import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';

/**
 * 迁移执行器（后端技术方案 02 §2）：
 * 1) manual/0000_extensions.sql（扩展，先于表创建）
 * 2) drizzle-kit 生成产物（meta/_journal.json 驱动，可从零重放）
 * 3) 其余 manual_*.sql（角色/RLS/跨模块 FK/表达式索引；IF NOT EXISTS 幂等 + 跟踪表防重放）
 *
 * 连接串取 MIGRATE_DATABASE_URL（缺省回退 DATABASE_URL）——
 * 生产指向 tradepilot_migrate 专用角色；dev 为表 owner（compose 初始化账号）。
 * 禁止运行时自动迁移（部署流水线串行执行：`pnpm --filter @tradepilot/db migrate`）。
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');
const MANUAL_DIR = join(MIGRATIONS_DIR, 'manual');

const connectionString = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString) {
  console.error('[migrate] 缺少 MIGRATE_DATABASE_URL / DATABASE_URL');
  process.exit(1);
}

async function applySqlFile(client: Client, filePath: string): Promise<void> {
  const sqlText = readFileSync(filePath, 'utf8');
  await client.query(sqlText);
}

async function main(): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    // 1. 扩展（每次执行，幂等）
    await applySqlFile(client, join(MANUAL_DIR, '0000_extensions.sql'));
    console.log('[migrate] extensions ready');

    // 2. drizzle 产物迁移
    const db = drizzle(client);
    await drizzleMigrate(db, { migrationsFolder: MIGRATIONS_DIR });
    console.log('[migrate] drizzle journal applied');

    // 3. manual 迁移（跟踪表防重放；文件内亦幂等，双保险）
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_manual_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query<{ name: string }>(
      'SELECT name FROM schema_manual_migrations',
    );
    const applied = new Set(rows.map((r) => r.name));
    const files = readdirSync(MANUAL_DIR)
      .filter((f) => f.endsWith('.sql') && !f.startsWith('0000_'))
      .sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      await applySqlFile(client, join(MANUAL_DIR, file));
      await client.query('INSERT INTO schema_manual_migrations (name) VALUES ($1)', [file]);
      console.log(`[migrate] manual applied: ${file}`);
    }

    console.log('[migrate] done');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
