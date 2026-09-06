import { Inject, Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import type { Role } from '@tradepilot/core';
import { BizException, ErrorCode } from '@tradepilot/core';
import type { Redis } from 'ioredis';
import { EnvService } from '../config/env.service.js';
import { REDIS } from '../redis/redis.module.js';

/**
 * JWT 签发与校验（技术方案 03 §1.3）：
 * HS256 单密钥；access 2h + refresh 14d（Redis 存储可撤销 refresh:{userId}:{jti}）。
 * Payload 仅 { sub, orgId, role }，不含敏感信息。
 */

export const ACCESS_TTL_SECONDS = 2 * 3600;
export const REFRESH_TTL_SECONDS = 14 * 24 * 3600;

export interface AccessTokenPayload {
  sub: string;
  orgId: string;
  role: Role;
  typ: 'access';
}

export interface RefreshTokenPayload {
  sub: string;
  orgId: string;
  role: Role;
  typ: 'refresh';
  /** RFC 7519 jti：refresh 撤销键 refresh:{sub}:{jti} */
  jti: string;
}

@Injectable()
export class TokenService {
  private readonly secret: Uint8Array;

  constructor(
    @Inject(EnvService) private readonly env: EnvService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    this.secret = new TextEncoder().encode(env.env.JWT_SECRET);
  }

  async signAccessToken(p: { sub: string; orgId: string; role: Role }): Promise<string> {
    return new SignJWT({ orgId: p.orgId, role: p.role, typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(p.sub)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
      .sign(this.secret);
  }

  /** 签发 refresh 并写入 Redis 撤销表（可 logout / 轮换） */
  async signRefreshToken(p: { sub: string; orgId: string; role: Role }): Promise<string> {
    const jti = crypto.randomUUID();
    const token = await new SignJWT({ orgId: p.orgId, role: p.role, typ: 'refresh', jti })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(p.sub)
      .setIssuedAt()
      .setExpirationTime(`${REFRESH_TTL_SECONDS}s`)
      .sign(this.secret);
    await this.redis.set(`refresh:${p.sub}:${jti}`, '1', 'EX', REFRESH_TTL_SECONDS);
    return token;
  }

  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    const payload = await this.verify(token);
    if (payload.typ !== 'access') {
      throw new BizException(ErrorCode.UNAUTHORIZED, '令牌类型错误');
    }
    return payload;
  }

  /** 校验 refresh：签名 + Redis 撤销表（被 logout/轮换过的立即失效） */
  async verifyRefreshToken(token: string): Promise<RefreshTokenPayload> {
    const payload = await this.verify(token);
    if (payload.typ !== 'refresh' || !payload.jti) {
      throw new BizException(ErrorCode.UNAUTHORIZED, '令牌类型错误');
    }
    const stored = await this.redis.get(`refresh:${payload.sub}:${payload.jti}`);
    if (stored === null) {
      throw new BizException(ErrorCode.UNAUTHORIZED, '登录已失效');
    }
    return payload;
  }

  /** 撤销 refresh（logout / 轮换时调用） */
  async revokeRefreshToken(token: string): Promise<void> {
    try {
      const payload = await this.verify(token);
      if (payload.typ === 'refresh' && payload.jti) {
        await this.redis.del(`refresh:${payload.sub}:${payload.jti}`);
      }
    } catch {
      // 已失效的 token 无需撤销
    }
  }

  private async verify(token: string): Promise<AccessTokenPayload | RefreshTokenPayload> {
    try {
      const { payload } = await jwtVerify(token, this.secret);
      const { sub, orgId, role, typ, jti } = payload as Record<string, unknown>;
      if (typeof sub !== 'string' || typeof orgId !== 'string') {
        throw new Error('payload 不完整');
      }
      if (typ === 'access') {
        return { sub, orgId, role: role as Role, typ: 'access' };
      }
      if (typ === 'refresh' && typeof jti === 'string') {
        return { sub, orgId, role: role as Role, typ: 'refresh', jti };
      }
      throw new Error('payload 不完整');
    } catch {
      throw new BizException(ErrorCode.UNAUTHORIZED, '未认证或登录已失效');
    }
  }
}
