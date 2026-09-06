import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { leadValue } from './enums.js';
import { org } from './01-org-user.js';
import { aiTask } from './02-ai-task.js';

/**
 * ER 03 · AI 获客模块（2 表）。
 * ai_lead.converted_customer_id 的 FK 由 manual 迁移补齐（04 建表后，ER 03 §3 注）。
 */

/** 匹配理由 Insight Schema（接口总览 §4.1）：{ value, confidence, reasons[] } */
export interface LeadInsight {
  value: number;
  confidence: number;
  reasons: { text: string; evidence?: string; source?: string }[];
}

export interface LeadOverview {
  companySize?: string;
  foundedYear?: number;
  customerType?: string;
  mainProducts?: string[];
  [k: string]: unknown;
}

export const aiLead = pgTable(
  'ai_lead',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    taskId: text('task_id').references(() => aiTask.id),
    companyName: text('company_name').notNull(),
    country: text('country').notNull(),
    industry: text('industry'),
    website: text('website'),
    /** 归一化域名（小写、去 www.），三级去重主键口径（03 §3.6） */
    companyDomain: text('company_domain'),
    matchPct: smallint('match_pct').notNull(),
    scoreLevel: leadValue('score_level').notNull(),
    insight: jsonb('insight').$type<LeadInsight>().notNull(),
    overview: jsonb('overview').$type<LeadOverview>(),
    analyzedAt: timestamp('analyzed_at', { withTimezone: true }),
    inCrm: boolean('in_crm').notNull().default(false),
    // FK→customer 由 manual 迁移补齐（04 建表后）
    convertedCustomerId: text('converted_customer_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_ai_lead_org_level')
      .on(t.orgId, t.scoreLevel)
      .where(sql`in_crm = false`),
    index('idx_ai_lead_org_task').on(t.orgId, t.taskId),
    index('idx_ai_lead_org_country').on(t.orgId, t.country),
    uniqueIndex('uq_ai_lead_org_domain')
      .on(t.orgId, t.companyDomain)
      .where(sql`${t.companyDomain} IS NOT NULL`),
  ],
);

export const aiLeadContact = pgTable(
  'ai_lead_contact',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    leadId: text('lead_id')
      .notNull()
      .references(() => aiLead.id),
    name: text('name').notNull(),
    title: text('title'),
    email: text('email'),
    decisionInfluencePct: smallint('decision_influence_pct'),
    source: text('source'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_ai_lead_contact_lead').on(t.leadId)],
);
