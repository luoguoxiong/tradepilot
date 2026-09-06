import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BizException, ErrorCode, type Role } from '@tradepilot/core';
import { ROLES_KEY } from '../decorators/roles.decorator.js';
import type { AccessTokenPayload } from '../token.service.js';

/**
 * RolesGuard（技术方案 03 §2.2 Guard 链第二环）：
 * @Roles(...) 未标注 = 三角色可访问；角色取自 JWT 解析后的 request.authUser
 * （JwtAuthGuard 已按库内校正）。
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }

    const req = context.switchToHttp().getRequest<Request & { authUser?: AccessTokenPayload }>();
    const role = req.authUser?.role;
    if (role === undefined || !required.includes(role)) {
      throw new BizException(ErrorCode.FORBIDDEN, '无权限执行该操作');
    }
    return true;
  }
}
