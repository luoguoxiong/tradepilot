import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { BizException, COST_ITEM_KEYS, createId, ErrorCode, type Role } from '@tradepilot/core';
import {
  schema,
  withOrg,
  type ApprovalRule,
  type CrmFieldMapping,
  type Db,
  type NotificationEvents,
  type RolePermissionMatrix,
  type Tx,
} from '@tradepilot/db';
import { DEFAULT_NOTIFICATION_EVENTS } from '@tradepilot/shared';
import { DB } from '../db/db.module.js';
import { highRiskApprovalTypes, mandatoryApprovalTypes } from './settings.dto.js';
import type {
  CreateCrmIntegrationDto,
  RolePermissionsDto,
  UpdateAiModelsDto,
  UpdateCrmIntegrationDto,
  UpdateNotificationsDto,
  UpdatePricingRulesDto,
} from './settings.dto.js';

/**
 * 设置服务（接口 16 §1.7/§1.8 / §3.5~§3.6）：
 * - 角色权限 + 审批规则：强制审批绑定不可被配置绕过（approverRoles 置空 → 42201）；
 *   high 类型（quote/contract/customer_delete）强制人工，autoApprove 置 true → 42201；
 * - 通知设置：org 单例，事件 × 渠道矩阵（channels 列存聚合总开关）；
 * - AI 模型：场景级路由 upsert（org 级，16 FR-10）；
 * - CRM 集成：授权连接 + 字段映射 + 同步方向（16 FR-06 / ER 01 §2.5，具体外呼由 CrmDriver 承接）。
 */

export interface RolePermissionsView {
  role: string;
  permissions: RolePermissionMatrix;
  approvalRules: ApprovalRule[];
}

export interface NotificationSettingsView {
  events: NotificationEvents;
}

export interface AiModelSettingView {
  scene: string;
  model: string;
  temperature: string;
  maxTokens: number;
  budgetLimit: string | null;
}

/** 产品与报价规则视图（16 §1.6，字段与接口文档逐字段一致） */
export interface PricingRulesView {
  productCategories: string[];
  costItems: string[];
  profitFloorPct: number;
  discountLadder: number[];
  defaultIncoterms: string;
  defaultCurrency: string;
  exchangeRateSource: string;
}

/** CRM 集成视图（16 §1.8 FR-06 / ER 01 §2.5，字段与接口文档逐字段一致） */
export interface CrmIntegrationView {
  id: string;
  /** 供应商（16 FR-06：xiaoman=小满 / futong=富通天下） */
  provider: string;
  /** connected / disconnected */
  status: string;
  /** pull / push / both */
  syncDirection: string;
  /** 字段映射（本地字段 → 外部 CRM 字段名）；未配置为 null */
  mapping: CrmFieldMapping[] | null;
  /** 最近同步时间（外呼驱动未接入前恒为 null，06 §6） */
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 缺省开关矩阵（16 §1.8；与 worker 通知分发兜底同源，shared 单一事实源） */
const DEFAULT_EVENTS: NotificationEvents = DEFAULT_NOTIFICATION_EVENTS;

/**
 * 缺省报价规则（16 §1.6；register 种子未预置，首访惰性落库）：
 * 成本项取引擎五项全集；利润红线 10%（保守基线，管理员可调）；
 * 让价梯度 [3,2,1]（ER 01 §2.6 示例）；默认 FOB / USD / manual。
 */
const DEFAULT_PRICING_RULES = {
  productCategories: [] as string[],
  costItems: [...COST_ITEM_KEYS] as string[],
  profitFloorPct: '10.00',
  discountLadder: [3, 2, 1] as number[],
  defaultIncoterms: 'FOB',
  defaultCurrency: 'USD',
  exchangeRateSource: 'manual',
};

@Injectable()
export class SettingsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ===== 权限管理（FR-08）=====

  async getRolePermissions(orgId: string, role: string): Promise<RolePermissionsView> {
    return this.withRole(orgId, parseRole(role), async (tx, role) => {
      const [row] = await tx
        .select()
        .from(schema.rolePermission)
        .where(eq(schema.rolePermission.role, role))
        .limit(1);
      if (!row) {
        throw new BizException(ErrorCode.NOT_FOUND, '角色不存在');
      }
      return { role: row.role, permissions: row.permissions, approvalRules: row.approvalRules };
    });
  }

  async updateRolePermissions(
    orgId: string,
    userId: string,
    role: string,
    dto: RolePermissionsDto,
  ): Promise<RolePermissionsView> {
    const parsedRole = parseRole(role);
    if (dto.permissions === undefined && dto.approvalRules === undefined) {
      throw new BizException(ErrorCode.BAD_REQUEST, 'permissions 与 approvalRules 至少一项');
    }
    if (dto.approvalRules !== undefined) {
      assertApprovalRules(dto.approvalRules);
    }
    return this.withRole(orgId, parsedRole, async (tx, role) => {
      const [current] = await tx
        .select()
        .from(schema.rolePermission)
        .where(eq(schema.rolePermission.role, role))
        .limit(1);
      if (!current) {
        throw new BizException(ErrorCode.NOT_FOUND, '角色不存在');
      }
      const [row] = await tx
        .update(schema.rolePermission)
        .set({
          ...(dto.permissions !== undefined && { permissions: dto.permissions }),
          ...(dto.approvalRules !== undefined && { approvalRules: dto.approvalRules }),
          updatedBy: userId,
          updatedAt: new Date(),
        })
        .where(eq(schema.rolePermission.id, current.id))
        .returning();
      if (!row) {
        throw new BizException(ErrorCode.INTERNAL, '权限更新失败');
      }
      return { role: row.role, permissions: row.permissions, approvalRules: row.approvalRules };
    });
  }

  // ===== 通知设置（FR-09）=====

  async getNotifications(orgId: string): Promise<NotificationSettingsView> {
    return withOrg(this.db, orgId, async (tx) => {
      const events = await ensureNotificationRow(tx, orgId);
      return { events };
    });
  }

  async updateNotifications(
    orgId: string,
    dto: UpdateNotificationsDto,
  ): Promise<NotificationSettingsView> {
    return withOrg(this.db, orgId, async (tx) => {
      const current = await ensureNotificationRow(tx, orgId);
      const events: NotificationEvents = {
        approval_pending: dto.events.approval_pending ?? current.approval_pending,
        risk_alert: dto.events.risk_alert ?? current.risk_alert,
        task_failed: dto.events.task_failed ?? current.task_failed,
      };
      // channels 列存聚合总开关（任一事件启用该渠道即为 true）
      await tx
        .update(schema.notificationSetting)
        .set({
          events,
          channels: {
            site: events.approval_pending.site || events.risk_alert.site || events.task_failed.site,
            email:
              events.approval_pending.email || events.risk_alert.email || events.task_failed.email,
          },
          updatedAt: new Date(),
        })
        .where(eq(schema.notificationSetting.orgId, orgId));
      return { events };
    });
  }

  // ===== AI 模型配置（FR-10）=====

  async getAiModels(orgId: string): Promise<{ scenes: AiModelSettingView[] }> {
    return withOrg(this.db, orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.aiModelSetting)
        .where(eq(schema.aiModelSetting.orgId, orgId));
      return { scenes: rows.map(toAiModelView) };
    });
  }

  async updateAiModels(
    orgId: string,
    dto: UpdateAiModelsDto,
  ): Promise<{ scenes: AiModelSettingView[] }> {
    return withOrg(this.db, orgId, async (tx) => {
      for (const scene of dto.scenes) {
        const [existing] = await tx
          .select({ id: schema.aiModelSetting.id })
          .from(schema.aiModelSetting)
          .where(
            and(
              eq(schema.aiModelSetting.orgId, orgId),
              eq(schema.aiModelSetting.scene, scene.scene),
            ),
          )
          .limit(1);

        if (existing) {
          // 已有配置：仅更新传入字段（budgetLimit 未传不改动；显式 null 清除）
          await tx
            .update(schema.aiModelSetting)
            .set({
              model: scene.model,
              ...(scene.temperature !== undefined && {
                temperature: scene.temperature.toFixed(2),
              }),
              ...(scene.maxTokens !== undefined && { maxTokens: scene.maxTokens }),
              ...(scene.budgetLimit !== undefined && {
                budgetLimit: scene.budgetLimit === null ? null : scene.budgetLimit.toFixed(2),
              }),
              updatedAt: new Date(),
            })
            .where(eq(schema.aiModelSetting.id, existing.id));
        } else {
          // 新场景：缺省值对齐注册种子基线（temperature 0.70 / maxTokens 4096）
          await tx.insert(schema.aiModelSetting).values({
            id: createId('amdl'),
            orgId,
            scene: scene.scene,
            model: scene.model,
            temperature: (scene.temperature ?? 0.7).toFixed(2),
            maxTokens: scene.maxTokens ?? 4096,
            ...(scene.budgetLimit !== undefined && {
              budgetLimit: scene.budgetLimit === null ? null : scene.budgetLimit.toFixed(2),
            }),
          });
        }
      }
      const rows = await tx
        .select()
        .from(schema.aiModelSetting)
        .where(eq(schema.aiModelSetting.orgId, orgId));
      return { scenes: rows.map(toAiModelView) };
    });
  }

  // ===== 产品与报价规则（FR-07，16 §1.6/§3.5）=====

  async getPricingRules(orgId: string): Promise<PricingRulesView> {
    return withOrg(this.db, orgId, async (tx) => {
      const row = await ensurePricingRuleRow(tx, orgId);
      return toPricingRuleView(row);
    });
  }

  async updatePricingRules(
    orgId: string,
    userId: string,
    dto: UpdatePricingRulesDto,
  ): Promise<PricingRulesView> {
    return withOrg(this.db, orgId, async (tx) => {
      await ensurePricingRuleRow(tx, orgId);
      const [row] = await tx
        .update(schema.pricingRuleSetting)
        .set({
          productCategories: dto.productCategories,
          costItems: dto.costItems,
          profitFloorPct: dto.profitFloorPct.toFixed(2),
          discountLadder: dto.discountLadder,
          defaultIncoterms: dto.defaultIncoterms,
          defaultCurrency: dto.defaultCurrency,
          exchangeRateSource: dto.exchangeRateSource,
          updatedBy: userId,
          updatedAt: new Date(),
        })
        .where(eq(schema.pricingRuleSetting.orgId, orgId))
        .returning();
      if (!row) {
        throw new BizException(ErrorCode.INTERNAL, '产品与报价规则更新失败');
      }
      return toPricingRuleView(row);
    });
  }

  // ===== CRM 集成（FR-06，16 §1.8 / ER 01 §2.5）=====

  async listCrmIntegrations(orgId: string): Promise<CrmIntegrationView[]> {
    return withOrg(this.db, orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.crmIntegration)
        .where(eq(schema.crmIntegration.orgId, orgId))
        .orderBy(asc(schema.crmIntegration.createdAt));
      return rows.map(toCrmIntegrationView);
    });
  }

  /** 授权连接：同一供应商每 org 至多一条（ER 01 §2.5 未加唯一约束，服务层拦截并给出可读错误） */
  async createCrmIntegration(
    orgId: string,
    dto: CreateCrmIntegrationDto,
  ): Promise<CrmIntegrationView> {
    return withOrg(this.db, orgId, async (tx) => {
      const [dup] = await tx
        .select({ id: schema.crmIntegration.id })
        .from(schema.crmIntegration)
        .where(
          and(
            eq(schema.crmIntegration.orgId, orgId),
            eq(schema.crmIntegration.provider, dto.provider),
          ),
        )
        .limit(1);
      if (dup) {
        throw new BizException(ErrorCode.CONFLICT, '该 CRM 供应商已接入');
      }
      const [row] = await tx
        .insert(schema.crmIntegration)
        .values({
          id: createId('cint'),
          orgId,
          provider: dto.provider,
          // 授权通过即视为已连接；断开走 PUT status='disconnected'
          status: 'connected',
          syncDirection: dto.syncDirection,
          mapping: normalizeMapping(dto.mapping),
        })
        .returning();
      if (!row) {
        throw new BizException(ErrorCode.INTERNAL, 'CRM 集成创建失败');
      }
      return toCrmIntegrationView(row);
    });
  }

  /** 更新同步方向 / 字段映射 / 连接状态（provider 不可变，切换供应商需断开后重新授权） */
  async updateCrmIntegration(
    orgId: string,
    id: string,
    dto: UpdateCrmIntegrationDto,
  ): Promise<CrmIntegrationView> {
    return withOrg(this.db, orgId, async (tx) => {
      const [current] = await tx
        .select({ id: schema.crmIntegration.id })
        .from(schema.crmIntegration)
        .where(and(eq(schema.crmIntegration.id, id), eq(schema.crmIntegration.orgId, orgId)))
        .limit(1);
      if (!current) {
        throw new BizException(ErrorCode.NOT_FOUND, 'CRM 集成不存在');
      }
      const [row] = await tx
        .update(schema.crmIntegration)
        .set({
          ...(dto.syncDirection !== undefined && { syncDirection: dto.syncDirection }),
          // 显式 null = 清空映射（空数组同义，见 normalizeMapping）
          ...(dto.mapping !== undefined && { mapping: normalizeMapping(dto.mapping) }),
          ...(dto.status !== undefined && { status: dto.status }),
          updatedAt: new Date(),
        })
        .where(eq(schema.crmIntegration.id, id))
        .returning();
      if (!row) {
        throw new BizException(ErrorCode.NOT_FOUND, 'CRM 集成不存在');
      }
      return toCrmIntegrationView(row);
    });
  }

  /** 断开连接：删除集成记录（历史同步数据保留，不回溯） */
  async removeCrmIntegration(orgId: string, id: string): Promise<{ id: string }> {
    return withOrg(this.db, orgId, async (tx) => {
      const [current] = await tx
        .select({ id: schema.crmIntegration.id })
        .from(schema.crmIntegration)
        .where(and(eq(schema.crmIntegration.id, id), eq(schema.crmIntegration.orgId, orgId)))
        .limit(1);
      if (!current) {
        throw new BizException(ErrorCode.NOT_FOUND, 'CRM 集成不存在');
      }
      await tx.delete(schema.crmIntegration).where(eq(schema.crmIntegration.id, id));
      return { id };
    });
  }

  /** withOrg + 角色参数类型收窄（enum 列 where 需要 Role 而非 string） */
  private withRole<T>(
    orgId: string,
    role: Role,
    fn: (tx: Tx, role: Role) => Promise<T>,
  ): Promise<T> {
    return withOrg(this.db, orgId, (tx) => fn(tx, role));
  }
}

// ===== helpers =====

/** 路径参数角色校验 + 类型收窄（enum 列） */
function parseRole(role: string): Role {
  if (role === 'admin' || role === 'manager' || role === 'sales') {
    return role;
  }
  throw new BizException(ErrorCode.NOT_FOUND, '角色不存在');
}

/** 强制审批绑定不可绕过（16 §3.6）：mandatory 类型 approverRoles 置空 → 42201；high 禁 autoApprove */
function assertApprovalRules(
  rules: {
    approvalType: string;
    approverRoles: string[];
    autoApprove?: boolean;
    /** 审批超时小时（12 §7.2；范围校验由 DTO zod 层完成） */
    expireHours?: number;
  }[],
): void {
  for (const rule of rules) {
    if (
      (mandatoryApprovalTypes as readonly string[]).includes(rule.approvalType) &&
      rule.approverRoles.length === 0
    ) {
      throw new BizException(ErrorCode.BIZ_VALIDATION, `${rule.approvalType} 审批绑定不可置空`);
    }
    if (
      (highRiskApprovalTypes as readonly string[]).includes(rule.approvalType) &&
      rule.autoApprove === true
    ) {
      throw new BizException(
        ErrorCode.BIZ_VALIDATION,
        `${rule.approvalType} 为高风险操作，强制人工审批`,
      );
    }
  }
}

/** org 单例缺行时落默认（register 种子未预置通知设置） */
async function ensureNotificationRow(tx: Tx, orgId: string): Promise<NotificationEvents> {
  const [row] = await tx
    .select({ events: schema.notificationSetting.events })
    .from(schema.notificationSetting)
    .where(eq(schema.notificationSetting.orgId, orgId))
    .limit(1);
  if (row) {
    return row.events;
  }
  await tx.insert(schema.notificationSetting).values({
    id: createId('ntf'),
    orgId,
    channels: { site: true, email: true },
    events: DEFAULT_EVENTS,
  });
  return DEFAULT_EVENTS;
}

/** org 单例缺行时落默认（register 种子未预置报价规则） */
async function ensurePricingRuleRow(
  tx: Tx,
  orgId: string,
): Promise<typeof schema.pricingRuleSetting.$inferSelect> {
  const [row] = await tx
    .select()
    .from(schema.pricingRuleSetting)
    .where(eq(schema.pricingRuleSetting.orgId, orgId))
    .limit(1);
  if (row) {
    return row;
  }
  const [created] = await tx
    .insert(schema.pricingRuleSetting)
    .values({ id: createId('prule'), orgId, ...DEFAULT_PRICING_RULES })
    .returning();
  if (!created) {
    throw new BizException(ErrorCode.INTERNAL, '产品与报价规则初始化失败');
  }
  return created;
}

function toPricingRuleView(row: typeof schema.pricingRuleSetting.$inferSelect): PricingRulesView {
  return {
    productCategories: row.productCategories,
    costItems: row.costItems,
    profitFloorPct: Number(row.profitFloorPct),
    discountLadder: row.discountLadder,
    defaultIncoterms: row.defaultIncoterms,
    defaultCurrency: row.defaultCurrency,
    exchangeRateSource: row.exchangeRateSource,
  };
}

/** mapping 归一：空数组与未配置等价（jsonb 存 null，避免 [] / null 两种空语义） */
function normalizeMapping(mapping: CrmFieldMapping[] | null | undefined): CrmFieldMapping[] | null {
  return mapping && mapping.length > 0 ? mapping : null;
}

function toCrmIntegrationView(row: typeof schema.crmIntegration.$inferSelect): CrmIntegrationView {
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    syncDirection: row.syncDirection,
    mapping: row.mapping ?? null,
    lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toAiModelView(row: typeof schema.aiModelSetting.$inferSelect): AiModelSettingView {
  return {
    scene: row.scene,
    model: row.model,
    temperature: row.temperature,
    maxTokens: row.maxTokens,
    budgetLimit: row.budgetLimit,
  };
}
