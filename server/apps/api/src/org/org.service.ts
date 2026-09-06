import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { BizException, createId, ErrorCode, type Role } from '@tradepilot/core';
import { schema, withLoginContext, withOrg, type Db, type OrgOnboarding } from '@tradepilot/db';
import { DB } from '../db/db.module.js';
import { REDIS } from '../redis/redis.module.js';
import type { InviteMemberDto, SendRulesDto, UpdateMemberDto, UpdateOrgDto } from './org.dto.js';
import { onboardingStepKeys } from './org.dto.js';

/**
 * 组织与成员服务（接口 16 §1.2/§1.3/§1.4 / 技术方案 03 §4/§6）：
 * - onboarding 断点续走：org.onboarding jsonb（currentStep 1-4 + steps 完成态）；
 * - 成员邀请：invited 占位账号 + 单次 7d 邀请 token（Redis），邮件发送随 M4 通知服务；
 * - 成员变更：至少保留一名可用管理员；停用即时失效（disabled:{userId}）。
 */

const INVITE_TTL_S = 7 * 24 * 3600;
/** 邀请占位密码：随机不可登录（接受邀请时补设） */
const PLACEHOLDER_HASH_PREFIX = 'invite-placeholder:';

export interface OnboardingStatus {
  currentStep: number;
  steps: { key: string; done: boolean }[];
}

export interface OrgProfile {
  id: string;
  name: string;
  logo: string | null;
  country: string | null;
  timezone: string;
  defaultLanguage: string;
  defaultCurrency: string;
  industry: string | null;
  sendRules: {
    timeWindowStart: string;
    timeWindowEnd: string;
    minTouchIntervalDays: number;
  } | null;
}

export interface MemberView {
  memberId: string;
  name: string;
  email: string;
  role: Role;
  status: 'active' | 'disabled' | 'invited';
  invitedAt: string | null;
  joinedAt: string | null;
}

@Injectable()
export class OrgService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // ===== 初始化向导（16 §1.2）=====

  /** 向导状态：steps 未初始化时按 currentStep 推导（company/products/mailbox/done） */
  async getOnboarding(orgId: string): Promise<OnboardingStatus> {
    return withOrg(this.db, orgId, async (tx) => {
      const [org] = await tx
        .select({ onboarding: schema.org.onboarding })
        .from(schema.org)
        .where(eq(schema.org.id, orgId))
        .limit(1);
      if (!org) {
        throw new BizException(ErrorCode.NOT_FOUND, '组织不存在');
      }
      return toOnboardingStatus(org.onboarding);
    });
  }

  /** 断点续走：前端每步完成回写 currentStep（1-4）；保留已有 steps 完成标记 */
  async updateOnboarding(orgId: string, currentStep: number): Promise<OnboardingStatus> {
    return withOrg(this.db, orgId, async (tx) => {
      const [org] = await tx
        .select({ onboarding: schema.org.onboarding })
        .from(schema.org)
        .where(eq(schema.org.id, orgId))
        .limit(1);
      if (!org) {
        throw new BizException(ErrorCode.NOT_FOUND, '组织不存在');
      }
      const steps = org.onboarding.steps.length > 0 ? org.onboarding.steps : defaultSteps();
      await tx
        .update(schema.org)
        .set({ onboarding: { currentStep, steps }, updatedAt: new Date() })
        .where(eq(schema.org.id, orgId));
      return toOnboardingStatus({ currentStep, steps });
    });
  }

  /** 副作用钩子：某步实际完成（如邮箱连接成功）→ steps 标记 done，不推进 currentStep */
  async markOnboardingStepDone(
    orgId: string,
    key: (typeof onboardingStepKeys)[number],
  ): Promise<void> {
    await withOrg(this.db, orgId, async (tx) => {
      const [org] = await tx
        .select({ onboarding: schema.org.onboarding })
        .from(schema.org)
        .where(eq(schema.org.id, orgId))
        .limit(1);
      if (!org) {
        return;
      }
      const steps = org.onboarding.steps.length > 0 ? [...org.onboarding.steps] : defaultSteps();
      const idx = steps.findIndex((s) => s.key === key);
      const current = idx >= 0 ? steps[idx] : undefined;
      if (current && !current.done) {
        steps[idx] = { ...current, done: true, completedAt: new Date().toISOString() };
        await tx
          .update(schema.org)
          .set({ onboarding: { ...org.onboarding, steps }, updatedAt: new Date() })
          .where(eq(schema.org.id, orgId));
      }
    });
  }

  // ===== 企业信息（16 §1.3：区域与本地化三默认值 + FR-12 外发规则）=====

  async getOrg(orgId: string): Promise<OrgProfile> {
    return withOrg(this.db, orgId, async (tx) => {
      const [org] = await tx.select().from(schema.org).where(eq(schema.org.id, orgId)).limit(1);
      if (!org) {
        throw new BizException(ErrorCode.NOT_FOUND, '组织不存在');
      }
      return toOrgProfile(org);
    });
  }

  /** 组织级变更仅 admin（03 §4，由 Controller @Roles 强制）；timezone 变更仅对新排期生效 */
  async updateOrg(orgId: string, dto: UpdateOrgDto): Promise<OrgProfile> {
    return withOrg(this.db, orgId, async (tx) => {
      const [org] = await tx
        .update(schema.org)
        .set({
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.logo !== undefined && { logoUrl: dto.logo }),
          ...(dto.country !== undefined && { country: dto.country }),
          ...(dto.timezone !== undefined && { timezone: dto.timezone }),
          ...(dto.defaultLanguage !== undefined && { defaultLanguage: dto.defaultLanguage }),
          ...(dto.defaultCurrency !== undefined && { defaultCurrency: dto.defaultCurrency }),
          ...(dto.industry !== undefined && { industry: dto.industry }),
          ...(dto.sendRules !== undefined && { sendRules: toSendRules(dto.sendRules) }),
          updatedAt: new Date(),
        })
        .where(eq(schema.org.id, orgId))
        .returning();
      if (!org) {
        throw new BizException(ErrorCode.NOT_FOUND, '组织不存在');
      }
      return toOrgProfile(org);
    });
  }

  // ===== 团队成员（16 §1.4 / 03 §6）=====

  async listMembers(orgId: string): Promise<MemberView[]> {
    return withOrg(this.db, orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.userAccount)
        .where(eq(schema.userAccount.orgId, orgId))
        .orderBy(asc(schema.userAccount.createdAt));
      return rows.map(toMemberView);
    });
  }

  /**
   * 邀请（03 §6）：invited 占位账号 + 单次 7d 邀请 token（Redis `invite:{token}`）；
   * 邀请邮件随 M4 通知服务落地，MVP 响应附 inviteToken 由管理员线下转达邀请链接。
   */
  async inviteMember(
    orgId: string,
    inviterId: string,
    dto: InviteMemberDto,
  ): Promise<MemberView & { inviteToken: string }> {
    const email = dto.email.toLowerCase();
    const existing = await withLoginContext(this.db, (tx) =>
      tx
        .select({ id: schema.userAccount.id })
        .from(schema.userAccount)
        .where(eq(schema.userAccount.email, email))
        .limit(1),
    );
    if (existing.length > 0) {
      throw new BizException(ErrorCode.CONFLICT, '该邮箱已在团队中或已被注册');
    }

    const member = await withOrg(this.db, orgId, async (tx) => {
      // 占位密码哈希：bcrypt 前缀标记，接受邀请前不可用于登录
      const placeholderHash = `${PLACEHOLDER_HASH_PREFIX}${randomBytes(24).toString('hex')}`;
      const [row] = await tx
        .insert(schema.userAccount)
        .values({
          id: createId('usr'),
          orgId,
          email,
          passwordHash: placeholderHash,
          name: email.split('@')[0] ?? email,
          role: dto.role,
          status: 'invited',
          invitedBy: inviterId,
          invitedAt: new Date(),
        })
        .returning();
      if (!row) {
        throw new BizException(ErrorCode.INTERNAL, '邀请创建失败');
      }
      return toMemberView(row);
    });

    const inviteToken = randomBytes(24).toString('base64url');
    await this.redis.set(
      `invite:${inviteToken}`,
      JSON.stringify({ orgId, email, role: dto.role, invitedBy: inviterId }),
      'EX',
      INVITE_TTL_S,
    );
    return { ...member, inviteToken };
  }

  /** 角色变更 / 停用启用（16 §1.4）；停用即时失效会话（03 §1.2） */
  async updateMember(orgId: string, memberId: string, dto: UpdateMemberDto): Promise<MemberView> {
    if (dto.role === undefined && dto.status === undefined) {
      throw new BizException(ErrorCode.BAD_REQUEST, 'role 与 status 至少一项');
    }
    return withOrg(this.db, orgId, async (tx) => {
      const [member] = await tx
        .select()
        .from(schema.userAccount)
        .where(and(eq(schema.userAccount.id, memberId), eq(schema.userAccount.orgId, orgId)))
        .limit(1);
      if (!member) {
        throw new BizException(ErrorCode.NOT_FOUND, '成员不存在');
      }

      // 防呆：不可降级/停用最后一个可用管理员（16 FR-03 交互边界）
      const demotingAdmin =
        member.role === 'admin' &&
        ((dto.role !== undefined && dto.role !== 'admin') || dto.status === 'disabled');
      if (demotingAdmin) {
        const [adminCount] = await tx
          .select({ activeAdmins: sql<number>`count(*)::int` })
          .from(schema.userAccount)
          .where(
            and(
              eq(schema.userAccount.orgId, orgId),
              eq(schema.userAccount.role, 'admin'),
              eq(schema.userAccount.status, 'active'),
            ),
          );
        if ((adminCount?.activeAdmins ?? 0) <= 1) {
          throw new BizException(ErrorCode.BIZ_VALIDATION, '至少保留一名可用管理员');
        }
      }

      const [updated] = await tx
        .update(schema.userAccount)
        .set({
          ...(dto.role !== undefined && { role: dto.role }),
          ...(dto.status !== undefined && { status: dto.status }),
          updatedAt: new Date(),
        })
        .where(eq(schema.userAccount.id, memberId))
        .returning();

      // 角色缓存与停用标记同步（03 §1.2）
      if (dto.role !== undefined) {
        await this.redis.del(`uctx:${memberId}`);
      }
      if (dto.status === 'disabled') {
        await this.redis.set(`disabled:${memberId}`, '1', 'EX', 30 * 24 * 3600);
      }
      if (dto.status === 'active' && member.status === 'disabled') {
        await this.redis.del(`disabled:${memberId}`);
      }
      if (!updated) {
        throw new BizException(ErrorCode.INTERNAL, '成员更新失败');
      }
      return toMemberView(updated);
    });
  }
}

// ===== 形状映射（内部 jsonb ↔ 接口契约，16 §1.2/§1.3）=====

function defaultSteps(): OrgOnboarding['steps'] {
  return onboardingStepKeys.map((key) => ({ key, done: false }));
}

function toOnboardingStatus(onboarding: OrgOnboarding): OnboardingStatus {
  const currentStep = onboarding.currentStep;
  const steps =
    onboarding.steps.length > 0
      ? onboarding.steps
      : // 未初始化时按 currentStep 推导（与前端向导口径一致）
        onboardingStepKeys.map((key, i) => ({
          key,
          done: key === 'done' ? currentStep >= 4 : currentStep > i + 1,
        }));
  return {
    currentStep,
    steps: steps.map((s) => ({ key: s.key, done: s.done })),
  };
}

function toSendRules(dto: SendRulesDto | null): {
  sendWindow: { start: string; end: string };
  minTouchIntervalDays: number;
} {
  // 空值回退默认窗口（07 §7.3：09:00-18:00 / 3 天）
  return {
    sendWindow: {
      start: dto?.timeWindowStart ?? '09:00',
      end: dto?.timeWindowEnd ?? '18:00',
    },
    minTouchIntervalDays: dto?.minTouchIntervalDays ?? 3,
  };
}

function toOrgProfile(org: typeof schema.org.$inferSelect): OrgProfile {
  return {
    id: org.id,
    name: org.name,
    logo: org.logoUrl,
    country: org.country,
    timezone: org.timezone ?? 'Asia/Shanghai',
    defaultLanguage: org.defaultLanguage ?? 'zh-CN',
    defaultCurrency: org.defaultCurrency ?? 'USD',
    industry: org.industry,
    sendRules: {
      timeWindowStart: org.sendRules.sendWindow.start,
      timeWindowEnd: org.sendRules.sendWindow.end,
      minTouchIntervalDays: org.sendRules.minTouchIntervalDays,
    },
  };
}

function toMemberView(u: typeof schema.userAccount.$inferSelect): MemberView {
  return {
    memberId: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    status: u.status,
    invitedAt: u.invitedAt?.toISOString() ?? null,
    joinedAt: u.joinedAt?.toISOString() ?? null,
  };
}

/** 供 auth 接受邀请流程复用：占位密码不可登录 */
export function isPlaceholderHash(hash: string): boolean {
  return hash.startsWith(PLACEHOLDER_HASH_PREFIX);
}
