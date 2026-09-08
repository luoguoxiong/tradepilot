import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema/index.js';
import { withOrg, withLoginContext, type Db, type Tx } from './tenant.js';

/**
 * @tradepilot/db —— Drizzle schema、迁移、RLS 策略、种子（后端技术方案 02）。
 * - schema/：ER 00~08 全量 46 表 + llm_call 记账增补
 * - withOrg：RLS 双保险 fail-closed（02 §4.3）
 * - migrations/：drizzle-kit 产物 + manual_*.sql（扩展/角色/RLS/跨模块 FK/表达式索引）
 * - seed/：注册事务种子（03 §1.1 / 02 §10）
 */

export type { Db, Tx };
export { withOrg, withLoginContext };
export { schema };
export type {
  OrgOnboarding,
  OrgSendRules,
  RolePermissionMatrix,
  ApprovalRule,
  EmployeeApprovalPolicy,
  EmployeeKpiConfig,
  SopContent,
  MailboxChannelConfig,
  MailboxOAuthConfig,
  MailboxSyncScope,
  NotificationChannels,
  NotificationEventKey,
  NotificationEventSwitch,
  NotificationEvents,
  Org,
  UserAccount,
  Mailbox,
} from './schema/index.js';
export * from './scope.js';
export { seedOrg } from './seed/register-seed.js';

/** 创建连接池（api 与 worker 各自独立；02 §3 池参数基线） */
export function createDb(
  connectionString: string,
  opts: { max?: number; statementTimeoutMs?: number } = {},
): Db {
  const pool = new Pool({
    connectionString,
    max: opts.max ?? 20,
    idleTimeoutMillis: 30_000,
    statement_timeout: opts.statementTimeoutMs ?? 15_000,
  });
  return drizzle(pool, { schema }) as Db;
}

/** 关闭连接池（进程优雅退出用） */
export async function closeDb(db: Db): Promise<void> {
  await db.$client.end();
}
