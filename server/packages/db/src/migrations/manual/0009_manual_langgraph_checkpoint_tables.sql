-- ============ 9. langgraph checkpointer 建表（05 §2 / #8 联调发现） ============
-- 背景：checkpoint 4 表原由 worker 启动时 PostgresSaver.setup() 执行 DDL 建立。
-- v0.1.6 把运行时 DATABASE_URL 由 superuser 换成 RLS 角色 tradepilot_app 后，
-- setup() 首句 `CREATE SCHEMA IF NOT EXISTS langgraph` 需要「数据库级 CREATE」权限
-- （0003 只授到 schema 级）→ 42501 permission denied for database tradepilot，
-- worker 启动即失败。故与业务表同口径：DDL 归迁移（以表 owner 身份执行），运行时只做 DML。
--
-- DDL 与 @langchain/langgraph-checkpoint-postgres@1.0.5 `getMigrations()` 逐字对齐；
-- 并写入 checkpoint_migrations 版本号 0~4（v4 = checkpoint_blobs.blob 可空），
-- 使将来显式调用 setup()（依赖升级新增列时）判定为「已迁移」，不重复执行。
-- 全文幂等，由 src/migrate.ts 在 drizzle 产物之后按序执行。

-- ============ 1. 建表（幂等） ============
CREATE TABLE IF NOT EXISTS langgraph.checkpoint_migrations (
  v INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS langgraph.checkpoints (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  type TEXT,
  checkpoint JSONB NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);

CREATE TABLE IF NOT EXISTS langgraph.checkpoint_blobs (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL,
  version TEXT NOT NULL,
  type TEXT NOT NULL,
  blob BYTEA,
  PRIMARY KEY (thread_id, checkpoint_ns, channel, version)
);

CREATE TABLE IF NOT EXISTS langgraph.checkpoint_writes (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  channel TEXT NOT NULL,
  type TEXT,
  blob BYTEA NOT NULL,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);

-- 包内 MIGRATIONS[4]（历史遗留的冗余语句，blob 在 CREATE 时即可空）
ALTER TABLE langgraph.checkpoint_blobs ALTER COLUMN blob DROP NOT NULL;

-- ============ 2. 版本号标记（0 = checkpoint_migrations 自身，4 = 最新） ============
INSERT INTO langgraph.checkpoint_migrations (v)
VALUES (0), (1), (2), (3), (4)
ON CONFLICT (v) DO NOTHING;

-- ============ 3. 角色授权（与 0003 同口径；0003 的 ALL TABLES 授权早于本迁移建表） ============
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA langgraph
  TO tradepilot_app, tradepilot_sched;
