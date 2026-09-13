import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { patchContext } from '../../context/request-context.js';
import { ApiKeyService, type ApiKeyAuth } from '../../open-api/api-key.service.js';
import { AuthService } from '../auth.service.js';
import { TokenService, type AccessTokenPayload } from '../token.service.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';

/**
 * JwtAuthGuard（技术方案 03 §2.2 Guard 链第一环）：
 * 1. 开放 API 通道：请求带 `x-api-key` → ApiKeyService 校验（scopes 由 ScopesGuard 二次校验）
 *    → 回填 request.apiKeyAuth 与 ALS；**不写 request.authUser**，故 `@Roles` 端点对 API Key 天然关闭；
 * 2. JWT 通道：Bearer（SSE 允许 ?token=）→ 校验签名 → 停用/角色以库内为准（AuthService.resolveLiveRole）
 *    → 回填 RequestContext（ALS）与 request.authUser。
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ApiKeyService) private readonly apiKeys: ApiKeyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const http = context.switchToHttp();
    const req = http.getRequest<Request & { apiKeyAuth?: ApiKeyAuth }>();

    // 开放 API 通道优先：存在 x-api-key 即走 Key 鉴权（P1-X-22 / 06 §5.1）
    const rawApiKey = req.headers['x-api-key'];
    if (typeof rawApiKey === 'string' && rawApiKey.trim().length > 0) {
      const apiKeyAuth = await this.apiKeys.authenticate(rawApiKey.trim());
      req.apiKeyAuth = apiKeyAuth;
      patchContext({
        orgId: apiKeyAuth.orgId,
        userId: apiKeyAuth.createdBy ?? `apikey_${apiKeyAuth.apiKeyId}`,
      });
      return true;
    }

    const token = this.extractToken(req);
    const payload: AccessTokenPayload = await this.tokens.verifyAccessToken(token);

    // 停用即时失效 + 角色库内为准（03 §1.2）
    const liveRole = await this.auth.resolveLiveRole(payload.sub);

    patchContext({ orgId: payload.orgId, userId: payload.sub, role: liveRole });
    (req as Request & { authUser: AccessTokenPayload }).authUser = {
      ...payload,
      role: liveRole,
    };
    return true;
  }

  /** Authorization: Bearer；SSE 端点 EventSource 无法带 header → 支持 ?token= */
  private extractToken(req: Request): string {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      return header.slice('Bearer '.length);
    }
    const queryToken = (req as Request & { query: Record<string, unknown> }).query['token'];
    if (typeof queryToken === 'string' && queryToken.length > 0) {
      return queryToken;
    }
    throw new UnauthorizedException('未认证或登录已失效');
  }
}
