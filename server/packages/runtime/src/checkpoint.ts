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

export async function createCheckpointer(databaseUrl: string): Promise<CheckpointerHandle> {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    // checkpointer 建表/读写均落在 langgraph schema（manual 迁移 0002 授权）
    options: '-c search_path=langgraph,public',
  });
  const saver = new PostgresSaver(pool);
  await saver.setup();
  return {
    saver,
    close: async () => {
      await pool.end();
    },
  };
}
