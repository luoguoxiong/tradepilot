import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import {
  assertScopeAllowed,
  BizException,
  ErrorCode,
  resolveScope,
  type Role,
  type Scope,
} from '@tradepilot/core';

/**
 * 数据范围查询注入（后端技术方案 03 §4.2）。
 * resolveScope / assertScopeAllowed 单一实现点在 @tradepilot/core（03 §4.1）。
 */

export { resolveScope, assertScopeAllowed };
export type { Scope, Role };

/** 软删过滤（02 §6.1）：repository 默认追加 deleted_at IS NULL；引用回溯场景显式绕过 */
export function notDeleted(deletedAtColumn: PgColumn): SQL {
  return sql`${deletedAtColumn} IS NULL`;
}

export interface ScopeContext {
  userId: string;
  role: Role;
  scope: Scope;
}

/** scope 上下文 + orgId（API 层服务常用形态：withOrg(this.db, ctx.orgId, ...)） */
export interface OrgScopeContext extends ScopeContext {
  orgId: string;
}

/**
 * 查询注入：
 * - self → owner_id = userId
 * - team → MVP manager 的 team = 本 org 全部成员（RLS 已限定 org），不追加条件；P1 团队分组后按成员集合过滤
 * - all  → 不追加
 */
export function applyOwnerScope(
  ownerColumn: PgColumn,
  ctx: ScopeContext,
  /** P1 团队分组：团队成员 ID 集合；缺省 = org 全员（不追加条件） */
  teamMemberIds?: string[],
): SQL | undefined {
  if (ctx.scope === 'self') {
    return eq(ownerColumn, ctx.userId);
  }
  if (ctx.scope === 'team' && teamMemberIds !== undefined) {
    if (teamMemberIds.length === 0) {
      return sql`false`;
    }
    return inArray(ownerColumn, teamMemberIds);
  }
  return undefined;
}

/** 与列表同口径的单资源校验（03 §4.2）：越权 40301，防旁路；返回收窄后的非空行 */
export function assertResourceAccess<T extends { ownerId?: string | null }>(
  row: T | null | undefined,
  ctx: ScopeContext,
): T {
  if (!row) {
    throw new BizException(ErrorCode.NOT_FOUND, '资源不存在');
  }
  if (ctx.scope === 'self' && row.ownerId !== ctx.userId) {
    throw new BizException(ErrorCode.FORBIDDEN, '无权限访问该资源');
  }
  return row;
}

/** 组合软删 + scope 等条件（可链式 and） */
export function scopeAnd(...conds: (SQL | undefined)[]): SQL | undefined {
  const valid = conds.filter((c): c is SQL => c !== undefined);
  if (valid.length === 0) return undefined;
  if (valid.length === 1) return valid[0];
  return and(...valid);
}
