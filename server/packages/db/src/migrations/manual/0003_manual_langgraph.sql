-- 0003_manual · langgraph checkpointer schema（后端技术方案 05 §2 / 04 §5）
-- 依据：PostgresSaver 与业务库同实例、独立 schema `langgraph`（连接串固定 search_path，
-- 见 packages/runtime/src/checkpoint.ts）；thread_id = taskId。
-- 全文幂等，由 src/migrate.ts 在 drizzle 产物之后按序执行。
-- 说明：checkpointer 建表由 PostgresSaver.setup() 在 worker 首次启动时执行（连接角色需拥有
-- 该 schema 的 DDL 权限）；本迁移负责 schema 创建与角色授权，使 setup() 可落地。

-- ============ 1. schema ============
CREATE SCHEMA IF NOT EXISTS langgraph;

-- ============ 2. 角色授权 ============
-- app / sched 运行时连接需读写 checkpointer 表（setup() 建表后的 DML）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tradepilot_app') THEN
    CREATE ROLE tradepilot_app LOGIN PASSWORD 'changeme_app';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tradepilot_sched') THEN
    CREATE ROLE tradepilot_sched LOGIN PASSWORD 'changeme_sched';
  END IF;
END $$;

GRANT USAGE ON SCHEMA langgraph TO tradepilot_app, tradepilot_sched;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA langgraph TO tradepilot_app, tradepilot_sched;
ALTER DEFAULT PRIVILEGES IN SCHEMA langgraph
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tradepilot_app, tradepilot_sched;

-- 注：PostgresSaver.setup() 执行 CREATE TABLE IF NOT EXISTS（checkpoints 等 4 表），
-- 由执行连接的角色拥有。若 worker 连接使用 tradepilot_app，需另行授予其 langgraph 建表权：
GRANT CREATE ON SCHEMA langgraph TO tradepilot_app;
