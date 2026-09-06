import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { BizException, createId, ErrorCode, type Role } from '@tradepilot/core';
import {
  schema,
  withOrg,
  type ApprovalRule,
  type Db,
  type NotificationEvents,
  type RolePermissionMatrix,
  type Tx,
} from '@tradepilot/db';
import { DB } from '../db/db.module.js';
import { highRiskApprovalTypes, mandatoryApprovalTypes } from './settings.dto.js';
import type {
  RolePermissionsDto,
  UpdateAiModelsDto,
  UpdateNotificationsDto,
} from './settings.dto.js';

/**
 * 设置服务（接口 16 §1.7/§1.8 / §3.5~§3.6）：
 * - 角色权限 + 审批规则：强制审批绑定不可被配置绕过（approverRoles 置空 → 42201）；
 *   high 类型（quote/contract/customer_delete）强制人工，autoApprove 置 true → 42201；
 * - 通知设置：org 单例，事件 × 渠道矩阵（channels 列存聚合总开关）；
 * - AI 模型：场景级路由 upsert（org 级，16 FR-10）。
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

const DEFAULT_EVENTS: NotificationEvents = {
  approval_pending: { site: true, email: true },
  risk_alert: { site: true, email: true },
  task_failed: { site: true, email: false },
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
  rules: { approvalType: string; approverRoles: string[]; autoApprove?: boolean }[],
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

function toAiModelView(row: typeof schema.aiModelSetting.$inferSelect): AiModelSettingView {
  return {
    scene: row.scene,
    model: row.model,
    temperature: row.temperature,
    maxTokens: row.maxTokens,
    budgetLimit: row.budgetLimit,
  };
}
