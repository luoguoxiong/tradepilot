import { BizException } from './errors.js';
import { ErrorCode } from './error-codes.js';

/**
 * 数据范围 scope=self|team|all（后端技术方案 03 §4.1）——单一实现点。
 * RLS 只解决 org 之间；org 之内按 owner_id 裁剪由 applyOwnerScope（packages/db）落地。
 * 本文件不依赖 drizzle，worker / 工具层可直接复用。
 */

/** 角色上限：sales→self、manager→team（可配 all）、admin→all */
export type Scope = 'self' | 'team' | 'all';
export type Role = 'admin' | 'manager' | 'sales';

const ROLE_SCOPE_CAP: Record<Role, Scope> = {
  admin: 'all',
  manager: 'team',
  sales: 'self',
};

const SCOPE_RANK: Record<Scope, number> = { self: 0, team: 1, all: 2 };

/** 请求 scope 超出角色上限 → 40301（接口总览 §4.4） */
export function assertScopeAllowed(role: Role, requested: Scope): void {
  if (SCOPE_RANK[requested] > SCOPE_RANK[ROLE_SCOPE_CAP[role]]) {
    throw new BizException(ErrorCode.FORBIDDEN, '数据范围超出角色权限');
  }
}

/** 生效 scope = min(请求 scope, 角色上限)；缺省取角色上限 */
export function resolveScope(role: Role, requested?: Scope | null): Scope {
  const cap = ROLE_SCOPE_CAP[role];
  if (requested === undefined || requested === null) {
    return cap;
  }
  assertScopeAllowed(role, requested);
  return SCOPE_RANK[requested] <= SCOPE_RANK[cap] ? requested : cap;
}
