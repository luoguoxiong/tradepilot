import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { activityType, customerStage, customerType, insightType, operatorType } from './enums.js';
import { org, userAccount } from './01-org-user.js';
import { aiTask } from './02-ai-task.js';

/**
 * ER 04 · 客户与 CRM 模块（4 表）。
 * customer.source_lead_id 的 FK 由 manual 迁移补齐（03 建表后，ER 04 §3 注）。
 */

export interface CustomerNextAction {
  type: string;
  label: string;
  targetId?: string;
}

export const customer = pgTable(
  'customer',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    companyName: text('company_name').notNull(),
    country: text('country').notNull(),
    website: text('website'),
    industry: text('industry'),
    industryTags: text('industry_tags').array(),
    customerType: customerType('customer_type'),
    stage: customerStage('stage').notNull().default('new_lead'),
    /** 客户身份：false 潜在（默认）/ true 正式；AI 不得变更（05 §7） */
    isFormal: boolean('is_formal').notNull().default(false),
    score: smallint('score'),
    ownerId: text('owner_id')
      .notNull()
      .references(() => userAccount.id),
    // FK→ai_lead 由 manual 迁移补齐
    sourceLeadId: text('source_lead_id'),
    nextAction: jsonb('next_action').$type<CustomerNextAction>(),
    remark: text('remark'),
    deleteLocked: boolean('delete_locked').notNull().default(false),
    createdBy: text('created_by').references(() => userAccount.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('uq_customer_org_name')
      .on(t.orgId, sql`lower(${t.companyName})`)
      .where(sql`${t.deletedAt} IS NULL`),
    index('idx_customer_org_stage').on(t.orgId, t.stage, t.updatedAt.desc()),
    index('idx_customer_org_owner').on(t.orgId, t.ownerId),
    index('idx_customer_org_score')
      .on(t.orgId, t.score.desc())
      .where(sql`${t.deletedAt} IS NULL`),
    index('idx_customer_org_country').on(t.orgId, t.country),
  ],
);

export interface InfluenceReason {
  text: string;
  evidence?: string;
  source?: string;
}

export const contact = pgTable(
  'contact',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    customerId: text('customer_id')
      .notNull()
      .references(() => customer.id),
    name: text('name').notNull(),
    title: text('title').notNull(),
    email: text('email'),
    phone: text('phone'),
    decisionInfluencePct: smallint('decision_influence_pct'),
    decisionInfluenceReasons: jsonb('decision_influence_reasons')
      .$type<InfluenceReason[]>()
      .notNull()
      .default([]),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_contact_org_email')
      .on(t.orgId, sql`lower(${t.email})`)
      .where(sql`${t.email} IS NOT NULL`),
    index('idx_contact_customer').on(t.customerId),
  ],
);

export const customerInsight = pgTable(
  'customer_insight',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    customerId: text('customer_id')
      .notNull()
      .references(() => customer.id),
    insightType: insightType('insight_type').notNull(),
    value: numeric('value'),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    reasons: jsonb('reasons').$type<InfluenceReason[]>().notNull().default([]),
    citations: jsonb('citations').$type<{ docId: string; chunkId?: string }[]>(),
    nextAction: jsonb('next_action').$type<CustomerNextAction>(),
    taskId: text('task_id').references(() => aiTask.id),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_customer_insight_type').on(t.customerId, t.insightType),
    index('idx_customer_insight_generated').on(t.customerId, t.generatedAt.desc()),
  ],
);

export const customerActivity = pgTable(
  'customer_activity',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    customerId: text('customer_id')
      .notNull()
      .references(() => customer.id),
    type: activityType('type').notNull(),
    summary: text('summary').notNull(),
    operatorType: operatorType('operator_type').notNull(),
    /** AI 员工（emp_）或用户（usr_）ID，多态 */
    operatorId: text('operator_id'),
    operatorName: text('operator_name'),
    refType: text('ref_type'),
    refId: text('ref_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_activity_customer').on(t.customerId, t.createdAt.desc()),
    index('idx_activity_org').on(t.orgId, t.createdAt.desc()),
    index('idx_activity_type').on(t.orgId, t.type, t.createdAt.desc()),
  ],
);
