import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import type * as schema from './schema/index.js';

/**
 * 多租户 RLS 会话注入（后端技术方案 02 §4.3）——唯一入口。
 * 业务代码不出现手写 where orgId；漏包 withOrg 时 RLS 返回空集（fail-closed）。
 */

export type Db = NodePgDatabase<typeof schema> & { $client: Pool };

/** drizzle transaction 回调入参（db 或 tx 二者可执行 SQL） */
export type Tx = Parameters<Parameters<NodePgDatabase<typeof schema>['transaction']>[0]>[0];

/** 任意可执行 SQL 的 drizzle 实例 */
export type Executable = Db | Tx;

/**
 * 以 org 上下文打开事务：`set_config('app.org_id', orgId, true)`（事务级）。
 * service 层所有跨表/多租户查询必须包在内；RLS 承担行级隔离。
 */
export async function withOrg<T>(db: Db, orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/**
 * 登录上下文事务：仅用于「按 email 全局定位用户」（03 §1.1）。
 * user_account 上有配套 login_lookup 策略（manual 迁移），其他表不受影响。
 */
export async function withLoginContext<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.login', '1', true)`);
    return fn(tx);
  });
}
