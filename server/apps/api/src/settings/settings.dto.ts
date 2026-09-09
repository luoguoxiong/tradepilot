import { z } from 'zod';

/**
 * 系统设置契约（接口 16 §1.5/§1.7/§1.8 / §3.3~§3.6）。
 * 权限：变更仅 admin（03 §4）；读取 admin+manager（settings: view）。
 */

// ===== 邮箱连接（16 §1.5/§3.3）=====

const mailboxChannelSchema = z.object({
  host: z.string().min(1, 'host 必填').max(253),
  port: z.number().int().min(1).max(65535),
  ssl: z.boolean(),
  /** 仅请求携带；AES-256-GCM 加密落库（08 §2），响应永不回显 */
  credential: z.string().min(1).max(1024),
});

export const createMailboxSchema = z.object({
  provider: z.enum(['gmail', 'outlook', 'smtp_imap']),
  account: z.string().email('邮箱格式不正确').max(254),
  imap: mailboxChannelSchema.optional(),
  smtp: mailboxChannelSchema.optional(),
  /** OAuth 凭据（gmail/outlook，06 §2.4）：refresh token 信封加密落库，响应永不回显 */
  oauth: z
    .object({
      /** OAuth 授权流程产出的 refresh token（仅请求携带） */
      refreshToken: z.string().min(1).max(2048),
    })
    .optional(),
  syncScope: z.object({
    historyDays: z.number().int().min(1).max(365),
    folders: z.array(z.string().min(1).max(64)).min(1).max(10),
  }),
});
export type CreateMailboxDto = z.infer<typeof createMailboxSchema>;

export const updateMailboxSchema = z.object({
  imap: mailboxChannelSchema.optional(),
  smtp: mailboxChannelSchema.optional(),
  oauth: z
    .object({
      refreshToken: z.string().min(1).max(2048).optional(),
    })
    .optional(),
  syncScope: z
    .object({
      historyDays: z.number().int().min(1).max(365),
      folders: z.array(z.string().min(1).max(64)).min(1).max(10),
    })
    .optional(),
});
export type UpdateMailboxDto = z.infer<typeof updateMailboxSchema>;

// ===== 权限管理（16 §1.7/§3.6：permissions + approvalRules）=====

export const mandatoryApprovalTypes = [
  'quote',
  'email_send',
  'contract',
  'order_change',
  'bulk_marketing',
  'customer_delete',
] as const;

/** medium 可开 autoApprove（12 §7.1）；high 类型（quote/contract/customer_delete）强制人工 */
export const highRiskApprovalTypes = ['quote', 'contract', 'customer_delete'] as const;

export const rolePermissionsSchema = z.object({
  permissions: z
    .object({
      customers: z.enum(['self', 'team', 'all']),
      quotes: z.enum(['approve', 'edit', 'view']),
      approvals: z.array(z.string().min(1).max(64)).max(16),
      settings: z.enum(['manage', 'view', 'none']),
    })
    .optional(),
  approvalRules: z
    .array(
      z.object({
        approvalType: z.string().min(1).max(64),
        approverRoles: z.array(z.enum(['admin', 'manager', 'sales'])),
        autoApprove: z.boolean().optional(),
        /** 本类型审批超时小时数（12 §7.2 按类型可配，缺省 48h；1~720 内整数） */
        expireHours: z.number().int().min(1).max(720).optional(),
      }),
    )
    .optional(),
});
export type RolePermissionsDto = z.infer<typeof rolePermissionsSchema>;

// ===== 通知设置（16 §1.8 FR-09：事件 × 渠道矩阵）=====

export const notificationEventsSchema = z.object({
  approval_pending: z.object({ site: z.boolean(), email: z.boolean() }).optional(),
  risk_alert: z.object({ site: z.boolean(), email: z.boolean() }).optional(),
  task_failed: z.object({ site: z.boolean(), email: z.boolean() }).optional(),
});
export const updateNotificationsSchema = z.object({ events: notificationEventsSchema });
export type UpdateNotificationsDto = z.infer<typeof updateNotificationsSchema>;

// ===== AI 模型配置（16 §1.8 FR-10：场景级路由 + 档位预算）=====

export const aiModelScenes = ['lead_hunting', 'email_reply', 'follow_up', 'analysis'] as const;

export const updateAiModelsSchema = z.object({
  scenes: z
    .array(
      z.object({
        scene: z.enum(aiModelScenes),
        model: z.string().min(1).max(128),
        temperature: z.number().min(0).max(2).optional(),
        maxTokens: z.number().int().min(1).max(200_000).optional(),
        budgetLimit: z.number().min(0).max(1_000_000).nullable().optional(),
      }),
    )
    .min(1)
    .max(16),
});
export type UpdateAiModelsDto = z.infer<typeof updateAiModelsSchema>;
