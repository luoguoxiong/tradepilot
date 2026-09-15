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

// ===== 产品与报价规则（16 §1.6/§3.5 FR-07：org 单例）=====

/**
 * 成本项白名单（09 §7.1 五项，技术键对应中文：采购/运费/保费/税费/汇兑）。
 * 与 @tradepilot/core 定价引擎 COST_ITEM_KEYS 同源，避免脏数据导致引擎缺项。
 */
export const pricingCostItemKeys = ['purchase', 'freight', 'insurance', 'tax', 'fx'] as const;

/** 贸易条款白名单（Incoterms 2020；MVP 默认 FOB） */
export const incotermsOptions = [
  'EXW',
  'FCA',
  'FAS',
  'FOB',
  'CFR',
  'CIF',
  'CPT',
  'CIP',
  'DAP',
  'DPU',
  'DDP',
] as const;

export const updatePricingRulesSchema = z.object({
  productCategories: z.array(z.string().min(1).max(64)).max(50),
  costItems: z.array(z.enum(pricingCostItemKeys)).min(1).max(pricingCostItemKeys.length),
  /** 利润红线：报价提交 100% 拦截（09 §3.2），修改后立即生效 */
  profitFloorPct: z.number().min(0).max(100),
  /** 让价梯度（如 [3,2,1]），每轮一个正整数百分比 */
  discountLadder: z.array(z.number().int().min(1).max(100)).max(10),
  defaultIncoterms: z.enum(incotermsOptions),
  /** 默认币种：ISO 4217 三位大写字母 */
  defaultCurrency: z.string().regex(/^[A-Z]{3}$/, '币种须为 3 位大写字母代码'),
  /** 汇率源：MVP 固定 manual（16 §1.6） */
  exchangeRateSource: z.literal('manual'),
});
export type UpdatePricingRulesDto = z.infer<typeof updatePricingRulesSchema>;

// ===== CRM 集成（16 §1.8 / FR-06：crm_integration，ER 01 §2.5）=====

/**
 * CRM 供应商白名单（16 FR-06「小满 / 富通天下」；ER 01 §2.5 provider 为 text，可扩展）。
 * MVP 仅落地「授权连接 + 字段映射 + 同步方向」配置（06 §6：不做任何外呼），
 * 实际拉取/推送由后续 CrmDriver 消费本配置（`CrmDriver { pullCustomers / pushCustomer / mapFields }`）。
 */
export const crmProviders = ['xiaoman', 'futong'] as const;

/** 同步方向（ER 01 §2.5）：pull=外部→本地 / push=本地→外部 / both=双向 */
export const crmSyncDirections = ['pull', 'push', 'both'] as const;

/** 连接状态（ER 01 §2.5）：connected=已授权 / disconnected=已断开 */
export const crmStatuses = ['connected', 'disconnected'] as const;

/**
 * 可映射的本地字段白名单（05 CRM 口径：customer / contact 业务字段）。
 * 之所以白名单化：mapping 直接驱动 CrmDriver.mapFields，脏字段名只会在同步时才暴露。
 */
export const crmLocalFields = [
  'customer.companyName',
  'customer.country',
  'customer.website',
  'customer.industry',
  'customer.remark',
  'contact.name',
  'contact.title',
  'contact.email',
  'contact.phone',
] as const;

/** 字段映射：本地字段（白名单）→ 外部 CRM 字段名（自由文本，各供应商命名不一） */
export const crmMappingSchema = z
  .array(
    z.object({
      local: z.enum(crmLocalFields),
      remote: z.string().min(1, '外部字段名必填').max(64),
    }),
  )
  .max(crmLocalFields.length)
  .refine(
    (fields) => new Set(fields.map((f) => f.local)).size === fields.length,
    '同一本地字段只能映射一次',
  );

export const createCrmIntegrationSchema = z.object({
  provider: z.enum(crmProviders),
  syncDirection: z.enum(crmSyncDirections),
  mapping: crmMappingSchema.optional(),
});
export type CreateCrmIntegrationDto = z.infer<typeof createCrmIntegrationSchema>;

export const updateCrmIntegrationSchema = z.object({
  syncDirection: z.enum(crmSyncDirections).optional(),
  /** 显式 null = 清空映射 */
  mapping: crmMappingSchema.nullable().optional(),
  status: z.enum(crmStatuses).optional(),
});
export type UpdateCrmIntegrationDto = z.infer<typeof updateCrmIntegrationSchema>;
