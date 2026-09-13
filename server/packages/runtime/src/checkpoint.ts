/**
 * LangGraph postgres checkpointer（后端技术方案 05 §2）：
 * 与业务库同实例，独立 schema `langgraph`（由 CHECKPOINT_SCHEMA 显式指定，
 * 见下方 schema 选项说明；setup() 建表亦落在该 schema）。
 * thread_id = taskId；风险对策 §5.1：若版本兼容异常，备选自研轻量检查点表。
 */
import { Pool } from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

/**
 * checkpoint 4 表所在 schema（manual 迁移 0003 建 schema、0009 建表）。
 * 必须显式传给 PostgresSaver：该包不读取连接 search_path，而是用构造参数的 schema
 * 直接拼限定表名（dist/sql.js `getTablesWithSchema` → `"langgraph".checkpoints`），
 * 缺省值为 'public'，漏传即报 `relation "public.checkpoints" does not exist`。
 */
const CHECKPOINT_SCHEMA = 'langgraph';

export interface CheckpointerHandle {
  saver: PostgresSaver;
  close(): Promise<void>;
}

export interface CheckpointerOptions {
  /**
   * 是否执行 `PostgresSaver.setup()`（DDL：CREATE SCHEMA / CREATE TABLE / 版本写入）。
   * 默认 false —— checkpoint 4 表的 DDL 归 manual 迁移 0009（以表 owner 身份执行），
   * 运行时角色 tradepilot_app 无数据库级 CREATE 权限，调用 setup() 会 42501
   * （`permission denied for database`，其首句即 `CREATE SCHEMA IF NOT EXISTS`）。
   * 仅在依赖升级需要补列时临时置 true（须用具备 DDL 权限的连接串）。
   */
  provisionSchema?: boolean;
}

export async function createCheckpointer(
  databaseUrl: string,
  options: CheckpointerOptions = {},
): Promise<CheckpointerHandle> {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    // checkpointer 读写落在 langgraph schema（manual 迁移 0003 授权）——仅为兜底，
    // 真正决定表名的是下面构造参数的 schema 选项（该包 SQL 已全部限定 schema）。
    options: '-c search_path=langgraph,public',
  });
  // 构造签名 (pool, serde, options)：serde 传 undefined 走内置默认序列化器。
  const saver = new PostgresSaver(pool, undefined, { schema: CHECKPOINT_SCHEMA });
  if (options.provisionSchema) {
    await saver.setup();
  }
  return {
    saver,
    close: async () => {
      await pool.end();
    },
  };
}
