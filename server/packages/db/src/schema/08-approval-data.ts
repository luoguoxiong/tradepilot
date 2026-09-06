import { sql } from 'drizzle-orm';
import {
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import {
  approvalStatus,
  approvalType,
  discoveryType,
  reportPeriod,
  reportStatus,
  riskLevel,
} from './enums.js';
import { org, userAccount } from './01-org-user.js';
import { aiEmployee, aiTask } from './02-ai-task.js';

/**
 * ER 08 · 审核与数据中心模块（5 表）。
 * approval_request.biz_type + biz_id 为多态引用，不建外键（ER 00 §5.2）。
 */

export const approvalRequest = pgTable(
  'approval_request',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    approvalType: approvalType('approval_type').notNull(),
    riskLevel: riskLevel('risk_level').notNull(),
    title: text('title').notNull(),
    /** quotation / message / sales_order / customer / follow_up_execution / ai_task */
    bizType: text('biz_type').notNull(),
    bizId: text('biz_id').notNull(),
    context: jsonb('context').$type<Record<string, unknown>>().notNull(),
    aiProposal: jsonb('ai_proposal').$type<Record<string, unknown>>().notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    reasons: jsonb('reasons')
      .$type<{ text: string; evidence?: string; source?: string }[]>()
      .notNull()
      .default([]),
    status: approvalStatus('status').notNull().default('pending'),
    requestedByEmployeeId: text('requested_by_employee_id').references(() => aiEmployee.id),
    requestedByUserId: text('requested_by_user_id').references(() => userAccount.id),
    /** 关联 AI 任务（waiting_approval 溯源），v0.1 不建 FK（ER 08 §3 说明①） */
    linkedTaskId: text('linked_task_id'),
    /** 超时时间（默认 48h，16 可配）；expired 为终态（Runtime §4.7） */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    decidedBy: text('decided_by').references(() => userAccount.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    resultRef: jsonb('result_ref').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_approval_org_status').on(t.orgId, t.status, t.approvalType, t.createdAt.desc()),
    index('idx_approval_biz').on(t.bizType, t.bizId),
    index('idx_approval_pending')
      .on(t.orgId, t.expiresAt)
      .where(sql`status = 'pending'`),
  ],
);

export const approvalLog = pgTable(
  'approval_log',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    approvalId: text('approval_id')
      .notNull()
      .references(() => approvalRequest.id),
    action: approvalStatus('action').notNull(),
    approverId: text('approver_id')
      .notNull()
      .references(() => userAccount.id),
    approverName: text('approver_name').notNull(),
    editedDiff: jsonb('edited_diff').$type<{ field: string; before: string; after: string }[]>(),
    rejectReason: text('reject_reason'),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('idx_alog_approval').on(t.approvalId, t.decidedAt.desc())],
);

export const businessReport = pgTable(
  'business_report',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    period: reportPeriod('period').notNull(),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    status: reportStatus('status').notNull().default('generating'),
    content: text('content'),
    citations: jsonb('citations').$type<Record<string, unknown>[]>(),
    taskId: text('task_id').references(() => aiTask.id),
    generatedAt: timestamp('generated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_report_org').on(t.orgId, t.period, t.createdAt.desc())],
);

export const aiDiscovery = pgTable(
  'ai_discovery',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    type: discoveryType('type').notNull(),
    title: text('title').notNull(),
    detail: text('detail').notNull(),
    evidence: jsonb('evidence')
      .$type<{ text: string; source?: string; ref?: string }[]>()
      .notNull()
      .default([]),
    /** 一键动作白名单仅限发起类（13 §7）：start_lead_task / enable_reactivation_strategy */
    suggestion: jsonb('suggestion').$type<Record<string, unknown>>().notNull(),
    status: text('status').notNull().default('new'),
    executedRef: jsonb('executed_ref').$type<Record<string, unknown>>(),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_discovery_org').on(t.orgId, t.type, t.createdAt.desc())],
);

export const analyticsDailySummary = pgTable(
  'analytics_daily_summary',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    statDate: date('stat_date').notNull(),
    country: text('country').notNull().default('ALL'),
    employeeId: text('employee_id').notNull().default('ALL'),
    newCustomers: integer('new_customers').notNull().default(0),
    newInquiries: integer('new_inquiries').notNull().default(0),
    newQuotes: integer('new_quotes').notNull().default(0),
    foundCustomers: integer('found_customers').notNull().default(0),
    repliedEmails: integer('replied_emails').notNull().default(0),
    promotedInquiries: integer('promoted_inquiries').notNull().default(0),
    savedHours: numeric('saved_hours', { precision: 10, scale: 1 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('uq_analytics_daily').on(t.orgId, t.statDate, t.country, t.employeeId)],
);
