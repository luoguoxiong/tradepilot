import { ROLE, SCOPE, type Role, type Scope } from '@tradepilot/shared';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 请求上下文（后端技术方案 01 §4.2）：
 * AsyncLocalStorage 携带 { traceId, orgId, userId, role, scope }，
 * 接口不传 orgId（从 JWT 解出），下游 repository / 工具调用全部从此读取。
 * worker 侧由 TaskRunner 构造同名上下文，保证 packages 层代码两侧一致。
 */
export interface RequestContext {
  traceId: string;
  orgId?: string;
  userId?: string;
  role?: Role;
  scope?: Scope;
}

const als = new AsyncLocalStorage<RequestContext>();

/** 执行回调并在其异步链路中注入请求上下文（中间件入口用） */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

/** 读取当前上下文（不在请求链路中时返回 undefined） */
export function getContext(): RequestContext | undefined {
  return als.getStore();
}

/** 读取当前上下文；业务写路径要求必须存在时用（缺上下文 fail） */
export function requireContext(): RequestContext {
  const ctx = als.getStore();
  if (!ctx) {
    throw new Error('请求上下文缺失：runWithContext 未初始化');
  }
  return ctx;
}

/** 更新当前上下文字段（如认证 Guard 解析 JWT 后回填 orgId/userId/role/scope） */
export function patchContext(patch: Partial<Omit<RequestContext, 'traceId'>>): void {
  const ctx = als.getStore();
  if (!ctx) {
    return;
  }
  if (patch.orgId !== undefined) ctx.orgId = patch.orgId;
  if (patch.userId !== undefined) ctx.userId = patch.userId;
  if (patch.role !== undefined && (ROLE as Record<string, string>)[patch.role])
    ctx.role = patch.role as Role;
  if (patch.scope !== undefined && (SCOPE as Record<string, string>)[patch.scope]) {
    ctx.scope = patch.scope as Scope;
  }
}

/** 当前 traceId（无上下文返回空串，日志绑定用） */
export function currentTraceId(): string {
  return als.getStore()?.traceId ?? '';
}
