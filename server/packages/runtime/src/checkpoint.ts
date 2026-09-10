/**
 * LangGraph postgres checkpointer（后端技术方案 05 §2）：
 * 与业务库同实例，独立 schema `langgraph`（连接串固定 search_path，setup() 建表落在该 schema）。
 * thread_id = taskId；风险对策 §5.1：若版本兼容异常，备选自研轻量检查点表。
 */
import { Pool } from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

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
    // checkpointer 读写落在 langgraph schema（manual 迁移 0003 授权）
    options: '-c search_path=langgraph,public',
  });
  const saver = new PostgresSaver(pool);
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
