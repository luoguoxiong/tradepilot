import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { BizException, ErrorCode } from '@tradepilot/core';
import type { ApiKeyAuth } from '../../open-api/api-key.service.js';
import { SCOPES_KEY } from '../decorators/scopes.decorator.js';

/**
 * ScopesGuard（技术方案 03 §2.2 Guard 链第三环，P1-X-22 / 06 §5.1）：
 * 仅作用于 API Key 通道（JwtAuthGuard 的 `x-api-key` 分支已回填 `request.apiKeyAuth`）：
 * - JWT 通道（无 apiKeyAuth）→ 直接放行，授权由 RolesGuard 承担；
 * - API Key 通道 → 端点必须显式声明 `@Scopes`，且 Key 具备全部所需 scope（fail-closed）。
 */
@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { apiKeyAuth?: ApiKeyAuth }>();
    const apiKey = req.apiKeyAuth;
    if (!apiKey) {
      return true;
    }

    const required = this.reflector.getAllAndOverride<string[] | undefined>(SCOPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      throw new BizException(ErrorCode.FORBIDDEN, '该端点未开放 API Key 访问');
    }

    const missing = required.filter((scope) => !apiKey.scopes.includes(scope));
    if (missing.length > 0) {
      throw new BizException(ErrorCode.FORBIDDEN, `API Key 缺少 scope：${missing.join(', ')}`);
    }
    return true;
  }
}
