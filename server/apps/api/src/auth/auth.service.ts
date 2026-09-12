import { Inject, Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { and, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { BizException, createId, ErrorCode, type Role } from '@tradepilot/core';
import { schema, seedOrg, withLoginContext, withOrg, type Db } from '@tradepilot/db';
import { DB } from '../db/db.module.js';
import { REDIS } from '../redis/redis.module.js';
import type { AcceptInvitationDto, LoginDto, RegisterDto } from './auth.dto.js';
import { ACCESS_TTL_SECONDS, TokenService } from './token.service.js';
import { isPlaceholderHash } from '../org/org.service.js';

/**
 * 认证服务（技术方案 03 §1.1/§1.2 / 接口 16 §3.1/§3.2）：
 * - 注册：bcrypt(cost 12) → 单事务 org + admin + 种子（02 §10），返回 token；
 * - 登录：防账号枚举（统一 40101 文案）+ 双维限流（账号 5 次/15min、IP 30 次/15min，08 §3）；
 * - JWT 库内角色为准（30s Redis 缓存），停用即时失效（disabled:{userId} 标记）。
 */

const BCRYPT_COST = 12;
const LOGIN_RATE_WINDOW_S = 15 * 60;
const LOGIN_ACCOUNT_MAX = 5;
const LOGIN_IP_MAX = 30;
/** 角色库内为准的缓存 TTL（03 §1.2） */
const USER_CTX_CACHE_S = 30;

export interface AuthTokens {
  token: string;
  refreshToken: string;
  expiresIn: number;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async register(
    dto: RegisterDto,
  ): Promise<AuthTokens & { user: { userId: string; orgId: string; role: Role } }> {
    // 全局唯一 email（MVP 单邮箱单企业，03 §1.1）——登录查找走 login_lookup 策略
    const email = dto.email.toLowerCase();
    const existing = await withLoginContext(this.db, (tx) =>
      tx
        .select({ id: schema.userAccount.id })
        .from(schema.userAccount)
        .where(eq(schema.userAccount.email, email))
        .limit(1),
    );
    if (existing.length > 0) {
      throw new BizException(ErrorCode.CONFLICT, '邮箱已被注册');
    }

    const orgId = createId('org');
    const userId = createId('user');
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);

    // 单事务：org + admin + 种子初始化（03 §1.1 ③）；区域与本地化三默认值（16 §1.3）
    await withOrg(this.db, orgId, async (tx) => {
      await tx.insert(schema.org).values({
        id: orgId,
        name: dto.companyName,
        timezone: 'Asia/Shanghai',
        defaultLanguage: 'zh-CN',
        defaultCurrency: 'USD',
      });
      await tx.insert(schema.userAccount).values({
        id: userId,
        orgId,
        email,
        passwordHash,
        name: dto.contactName,
        role: 'admin',
        status: 'active',
        joinedAt: new Date(),
      });
      await seedOrg(tx, orgId, userId);
    });

    return {
      ...(await this.issueTokens(userId, orgId, 'admin')),
      user: { userId, orgId, role: 'admin' },
    };
  }

  async login(
    dto: LoginDto,
    clientIp: string,
  ): Promise<AuthTokens & { onboarding: { currentStep: number } }> {
    const email = dto.email.toLowerCase();

    // 双维限流（08 §3）：超限 42901；计数在密码校验前递增，防爆破
    await this.assertLoginRateLimit(email, clientIp);

    // 登录上下文：按 email 全局定位用户（login_lookup 策略，03 §1.1）
    // 注意：不能在此 join org —— org 表 RLS 按 app.org_id 过滤，登录上下文未设 org_id
    // 会导致 inner join 恒空、一律 40101（切专用角色后暴露，owner 模式绕过 RLS 掩盖）
    const rows = await withLoginContext(this.db, (tx) =>
      tx
        .select({
          id: schema.userAccount.id,
          orgId: schema.userAccount.orgId,
          role: schema.userAccount.role,
          status: schema.userAccount.status,
          passwordHash: schema.userAccount.passwordHash,
        })
        .from(schema.userAccount)
        .where(eq(schema.userAccount.email, email))
        .limit(1),
    );
    const user = rows[0];

    // 防账号枚举：账号不存在 / 已停用 / 密码错误 → 同一文案同一错误码
    const passwordOk =
      user !== undefined && (await bcrypt.compare(dto.password, user.passwordHash));
    if (user === undefined || user.status === 'disabled' || !passwordOk) {
      throw new BizException(ErrorCode.UNAUTHORIZED, '邮箱或密码错误');
    }

    // org.onboarding 在 org 上下文中单独读取（RLS 按 org_id 过滤）
    const orgContextResult = await withOrg(this.db, user.orgId, (tx) =>
      tx
        .select({ onboarding: schema.org.onboarding })
        .from(schema.org)
        .where(eq(schema.org.id, user.orgId))
        .limit(1),
    );
    const currentStep = orgContextResult[0]?.onboarding?.currentStep ?? 0;
    await withOrg(this.db, user.orgId, (tx) =>
      tx
        .update(schema.userAccount)
        .set({ lastLoginAt: new Date() })
        .where(eq(schema.userAccount.id, user.id)),
    );

    return {
      ...(await this.issueTokens(user.id, user.orgId, user.role)),
      onboarding: { currentStep },
    };
  }

  async logout(userId: string, refreshToken?: string): Promise<{ ok: true }> {
    if (refreshToken) {
      await this.tokens.revokeRefreshToken(refreshToken);
    }
    return { ok: true };
  }

  /** 轮换：旧 refresh 立即撤销，签发新对（03 §1.3） */
  async refresh(oldToken: string): Promise<AuthTokens> {
    const payload = await this.tokens.verifyRefreshToken(oldToken);
    await this.assertNotDisabled(payload.sub);
    await this.tokens.revokeRefreshToken(oldToken);
    return this.issueTokens(payload.sub, payload.orgId, payload.role);
  }

  /**
   * 接受邀请（03 §1.1）：单次邀请 token（Redis `invite:{token}`，7d）→ 补密码 →
   * member_status: invited → active → 直接签发会话。token 消费后立即删除（单次有效）。
   */
  async acceptInvitation(
    dto: AcceptInvitationDto,
  ): Promise<AuthTokens & { user: { userId: string; orgId: string; role: Role } }> {
    const raw = await this.redis.get(`invite:${dto.token}`);
    if (raw === null) {
      throw new BizException(ErrorCode.NOT_FOUND, '邀请链接无效或已过期');
    }
    const invite = JSON.parse(raw) as { orgId: string; email: string; role: Role };

    // 占位密码不可登录：登录路径 bcrypt.compare 对非 bcrypt 哈希恒 false（防账号枚举同文案）
    const rows = await withLoginContext(this.db, (tx) =>
      tx
        .select({
          id: schema.userAccount.id,
          orgId: schema.userAccount.orgId,
          role: schema.userAccount.role,
          status: schema.userAccount.status,
          passwordHash: schema.userAccount.passwordHash,
        })
        .from(schema.userAccount)
        .where(eq(schema.userAccount.email, invite.email))
        .limit(1),
    );
    const user = rows[0];
    if (!user || user.orgId !== invite.orgId || user.status !== 'invited') {
      throw new BizException(ErrorCode.CONFLICT, '邀请已被接受或成员状态异常');
    }
    if (!isPlaceholderHash(user.passwordHash)) {
      throw new BizException(ErrorCode.CONFLICT, '邀请已被接受');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);
    await withOrg(this.db, invite.orgId, (tx) =>
      tx
        .update(schema.userAccount)
        .set({
          name: dto.name,
          passwordHash,
          status: 'active',
          joinedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(schema.userAccount.id, user.id), eq(schema.userAccount.orgId, invite.orgId))),
    );

    // 单次消费：先删 token 再签发，避免并发重放
    await this.redis.del(`invite:${dto.token}`);
    return {
      ...(await this.issueTokens(user.id, invite.orgId, invite.role)),
      user: { userId: user.id, orgId: invite.orgId, role: invite.role },
    };
  }

  /** 当前用户与权限（接口 16 §2：GET /auth/me）——权限实时读 role_permission */
  async me(
    userId: string,
    orgId: string,
  ): Promise<{
    userId: string;
    orgId: string;
    role: Role;
    name: string;
    email: string;
    permissions: Record<string, unknown>;
  }> {
    return withOrg(this.db, orgId, async (tx) => {
      const [user] = await tx
        .select({
          id: schema.userAccount.id,
          role: schema.userAccount.role,
          name: schema.userAccount.name,
          email: schema.userAccount.email,
        })
        .from(schema.userAccount)
        .where(and(eq(schema.userAccount.id, userId), eq(schema.userAccount.orgId, orgId)))
        .limit(1);
      if (!user) {
        throw new BizException(ErrorCode.UNAUTHORIZED, '用户不存在或已失效');
      }
      const [perm] = await tx
        .select({ permissions: schema.rolePermission.permissions })
        .from(schema.rolePermission)
        .where(
          and(eq(schema.rolePermission.orgId, orgId), eq(schema.rolePermission.role, user.role)),
        )
        .limit(1);
      return {
        userId: user.id,
        orgId,
        role: user.role,
        name: user.name,
        email: user.email,
        permissions: perm?.permissions ?? {},
      };
    });
  }

  /** Guard 用：角色库内为准（30s 缓存）+ 停用即时失效（03 §1.2） */
  async resolveLiveRole(userId: string): Promise<Role> {
    await this.assertNotDisabled(userId);
    const cacheKey = `uctx:${userId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return cached as Role;
    }
    const rows = await withLoginContext(this.db, (tx) =>
      tx
        .select({ role: schema.userAccount.role })
        .from(schema.userAccount)
        .where(eq(schema.userAccount.id, userId))
        .limit(1),
    );
    const role = rows[0]?.role;
    if (!role) {
      throw new BizException(ErrorCode.UNAUTHORIZED, '用户不存在或已失效');
    }
    await this.redis.set(cacheKey, role, 'EX', USER_CTX_CACHE_S);
    return role;
  }

  private async issueTokens(userId: string, orgId: string, role: Role): Promise<AuthTokens> {
    return {
      token: await this.tokens.signAccessToken({ sub: userId, orgId, role }),
      refreshToken: await this.tokens.signRefreshToken({ sub: userId, orgId, role }),
      expiresIn: ACCESS_TTL_SECONDS,
    };
  }

  private async assertNotDisabled(userId: string): Promise<void> {
    if ((await this.redis.get(`disabled:${userId}`)) !== null) {
      throw new BizException(ErrorCode.UNAUTHORIZED, '账号已停用');
    }
  }

  private async assertLoginRateLimit(email: string, clientIp: string): Promise<void> {
    const fail = (): BizException =>
      new BizException(ErrorCode.RATE_LIMITED, '登录尝试过于频繁，请稍后再试');

    const acctKey = `rl:login:u:${email}`;
    const acctCount = await this.redis.incr(acctKey);
    if (acctCount === 1) {
      await this.redis.expire(acctKey, LOGIN_RATE_WINDOW_S);
    }
    if (acctCount > LOGIN_ACCOUNT_MAX) {
      throw fail();
    }

    const ipKey = `rl:login:ip:${clientIp}`;
    const ipCount = await this.redis.incr(ipKey);
    if (ipCount === 1) {
      await this.redis.expire(ipKey, LOGIN_RATE_WINDOW_S);
    }
    if (ipCount > LOGIN_IP_MAX) {
      throw fail();
    }
  }
}
