import { sql } from 'drizzle-orm';
import {
  char,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { mailboxProvider, mailboxStatus, memberStatus, userRole } from './enums.js';

/**
 * ER 01 · 企业与用户设置模块（10 表）。
 * id 一律应用层生成（createId），不设 DB 默认值。
 */

/** 16 §1.2 初始化向导：{ currentStep: 1-4, steps: [{ key, done, completedAt }] } */
export interface OrgOnboarding {
  currentStep: number;
  steps: { key: string; done: boolean; completedAt?: string }[];
}

/** 16 FR-12 外发规则：{ sendWindow: { start, end }, minTouchIntervalDays } */
export interface OrgSendRules {
  sendWindow: { start: string; end: string };
  minTouchIntervalDays: number;
}

export const org = pgTable('org', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  logoUrl: text('logo_url'),
  country: text('country'),
  timezone: text('timezone'),
  defaultLanguage: text('default_language'),
  defaultCurrency: char('default_currency', { length: 3 }),
  industry: text('industry'),
  onboarding: jsonb('onboarding')
    .$type<OrgOnboarding>()
    .notNull()
    .default({ currentStep: 1, steps: [] }),
  sendRules: jsonb('send_rules')
    .$type<OrgSendRules>()
    .notNull()
    .default({ sendWindow: { start: '09:00', end: '18:00' }, minTouchIntervalDays: 3 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const userAccount = pgTable(
  'user_account',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    role: userRole('role').notNull(),
    status: memberStatus('status').notNull().default('invited'),
    invitedBy: text('invited_by'),
    invitedAt: timestamp('invited_at', { withTimezone: true }),
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // MVP 单邮箱单企业（03 §1.1）：全局唯一 email，登录直接定位 org
    uniqueIndex('uq_user_global_email').on(t.email),
    unique('uq_user_org_email').on(t.orgId, t.email),
    index('idx_user_org_status').on(t.orgId, t.status),
    index('idx_user_invited_by').on(t.invitedBy),
  ],
);

/** 16 §1.7 权限矩阵 jsonb */
export interface RolePermissionMatrix {
  customers: 'self' | 'team' | 'all';
  quotes: 'approve' | 'edit' | 'view';
  approvals: string[];
  settings: 'manage' | 'view' | 'none';
  [k: string]: unknown;
}

export interface ApprovalRule {
  approvalType: string;
  approverRoles: string[];
  /** org autoApprove 自动通过开关（12 §7.1，仅 medium 类型可开） */
  autoApprove?: boolean;
  /** 本类型审批超时小时数（12 §7.2「按类型默认 48h」；缺省回落 48h，16 设置按类型可配） */
  expireHours?: number;
}

export const rolePermission = pgTable(
  'role_permission',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    role: userRole('role').notNull(),
    permissions: jsonb('permissions').$type<RolePermissionMatrix>().notNull(),
    approvalRules: jsonb('approval_rules').$type<ApprovalRule[]>().notNull().default([]),
    updatedBy: text('updated_by').references(() => userAccount.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('uq_role_perm_org_role').on(t.orgId, t.role)],
);

/** imap/smtp 凭据：credential_enc 为密文（08 §2），任何接口永不回显明文 */
export interface MailboxChannelConfig {
  host: string;
  port: number;
  ssl: boolean;
  credential_enc?: string;
}

export interface MailboxSyncScope {
  historyDays: number;
  folders: string[];
}

export const mailbox = pgTable(
  'mailbox',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    ownerUserId: text('owner_user_id').references(() => userAccount.id),
    provider: mailboxProvider('provider').notNull(),
    account: text('account').notNull(),
    imap: jsonb('imap').$type<MailboxChannelConfig>(),
    smtp: jsonb('smtp').$type<MailboxChannelConfig>(),
    syncScope: jsonb('sync_scope').$type<MailboxSyncScope>().notNull(),
    status: mailboxStatus('status').notNull(),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_mailbox_org_account').on(t.orgId, sql`lower(${t.account})`)],
);

export const crmIntegration = pgTable('crm_integration', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => org.id),
  provider: text('provider').notNull(),
  status: text('status').notNull(),
  syncDirection: text('sync_direction').notNull(),
  mapping: jsonb('mapping'),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pricingRuleSetting = pgTable(
  'pricing_rule_setting',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    productCategories: text('product_categories').array().notNull(),
    costItems: text('cost_items').array().notNull(),
    profitFloorPct: numeric('profit_floor_pct', { precision: 5, scale: 2 }).notNull(),
    discountLadder: smallint('discount_ladder').array().notNull(),
    defaultIncoterms: text('default_incoterms').notNull(),
    defaultCurrency: char('default_currency', { length: 3 }).notNull(),
    exchangeRateSource: text('exchange_rate_source').notNull(),
    updatedBy: text('updated_by').references(() => userAccount.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('uq_pricing_rule_org').on(t.orgId)],
);

export interface NotificationChannels {
  site: boolean;
  email: boolean;
}

/**
 * 事件 × 渠道开关矩阵（接口 16 §1.8 FR-09 / 前端契约）：
 * 每个 event 独立配置 site/email 两路开关；channels 列存聚合总开关（任一事件开启）。
 */
export type NotificationEventKey = 'approval_pending' | 'risk_alert' | 'task_failed';

export type NotificationEventSwitch = { site: boolean; email: boolean };

export type NotificationEvents = Record<NotificationEventKey, NotificationEventSwitch>;

export const notificationSetting = pgTable(
  'notification_setting',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    channels: jsonb('channels').$type<NotificationChannels>().notNull(),
    events: jsonb('events').$type<NotificationEvents>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('uq_notification_org').on(t.orgId)],
);

export const aiModelSetting = pgTable(
  'ai_model_setting',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    scene: text('scene').notNull(),
    model: text('model').notNull(),
    temperature: numeric('temperature', { precision: 3, scale: 2 }).notNull().default('0.70'),
    maxTokens: integer('max_tokens').notNull(),
    budgetLimit: numeric('budget_limit', { precision: 12, scale: 2 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('uq_ai_model_org_scene').on(t.orgId, t.scene)],
);

export const apiKey = pgTable(
  'api_key',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    name: text('name').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes').array().notNull(),
    status: text('status').notNull().default('active'),
    createdBy: text('created_by').references(() => userAccount.id),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_api_key_hash').on(t.keyHash)],
);

export const webhook = pgTable('webhook', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => org.id),
  url: text('url').notNull(),
  events: text('events').array().notNull(),
  secretEnc: text('secret_enc').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// org 为租户根：business code 亦经 withOrg 读写（RLS 策略见 migrations/manual）
export type Org = typeof org.$inferSelect;
export type UserAccount = typeof userAccount.$inferSelect;
export type Mailbox = typeof mailbox.$inferSelect;
