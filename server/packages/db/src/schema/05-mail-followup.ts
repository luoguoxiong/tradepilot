import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  aiIntent,
  autoSendPolicy,
  conversationPriority,
  followUpStage,
  followUpTaskStatus,
  fexecStatus,
  msgDirection,
  msgStatus,
  senderType,
} from './enums.js';
import { mailbox, org, userAccount } from './01-org-user.js';
import { contact, customer } from './04-customer.js';
import { knowledgeDocument } from './06-product-knowledge.js';

/**
 * ER 05 · 销售邮件与自动跟进模块（7 表）。
 * follow_up_execution.approval_id 的 FK 由 manual 迁移补齐（08 建表后，ER 05 §3 注）。
 */

export const conversation = pgTable(
  'conversation',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    customerId: text('customer_id')
      .notNull()
      .references(() => customer.id),
    contactId: text('contact_id').references(() => contact.id),
    channel: text('channel').notNull().default('email'),
    subject: text('subject'),
    priority: conversationPriority('priority').notNull().default('pending'),
    unreadCount: integer('unread_count').notNull().default(0),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    lastMessagePreview: text('last_message_preview'),
    mailboxId: text('mailbox_id').references(() => mailbox.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_conversation_org_recent').on(t.orgId, t.lastMessageAt.desc()),
    index('idx_conversation_org_priority').on(t.orgId, t.priority),
    index('idx_conversation_customer').on(t.customerId),
  ],
);

export interface MessageCitation {
  docId: string;
  docName?: string;
  chunkId?: string;
}

export const message = pgTable(
  'message',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversation.id),
    direction: msgDirection('direction').notNull(),
    senderType: senderType('sender_type').notNull(),
    senderName: text('sender_name').notNull(),
    mailboxId: text('mailbox_id').references(() => mailbox.id),
    content: text('content').notNull(),
    /** 消息语言（来信检测 / 草稿生成语言），跟随最近一条 in 消息（06 §7） */
    language: text('language'),
    status: msgStatus('status').notNull().default('draft'),
    citations: jsonb('citations').$type<MessageCitation[]>(),
    basedOnMessageId: text('based_on_message_id').references((): AnyPgColumn => message.id),
    editedDiff: jsonb('edited_diff').$type<{ field: string; before: string; after: string }[]>(),
    externalMessageId: text('external_message_id'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_message_conversation').on(t.conversationId, t.createdAt),
    uniqueIndex('uq_message_external')
      .on(t.mailboxId, t.externalMessageId)
      .where(sql`${t.externalMessageId} IS NOT NULL`),
    index('idx_message_draft')
      .on(t.orgId, t.status)
      .where(sql`status = 'draft'`),
  ],
);

export const conversationInsight = pgTable(
  'conversation_insight',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversation.id),
    intent: aiIntent('intent').notNull(),
    purchaseProbability: smallint('purchase_probability'),
    suggestions: jsonb('suggestions')
      .$type<{ suggestionId: string; label: string }[]>()
      .notNull()
      .default([]),
    citations: jsonb('citations').$type<MessageCitation[]>(),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('uq_conversation_insight').on(t.conversationId)],
);

export const followUpStrategy = pgTable('follow_up_strategy', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => org.id),
  name: text('name').notNull(),
  targetScope: jsonb('target_scope').$type<Record<string, unknown>>().notNull(),
  autoSendPolicy: autoSendPolicy('auto_send_policy').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  isDefault: boolean('is_default').notNull().default(false),
  createdBy: text('created_by').references(() => userAccount.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const followUpStrategyStep = pgTable(
  'follow_up_strategy_step',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    strategyId: text('strategy_id')
      .notNull()
      .references(() => followUpStrategy.id),
    seq: smallint('seq').notNull(),
    dayOffset: smallint('day_offset').notNull(),
    title: text('title').notNull(),
    templateId: text('template_id').references(() => knowledgeDocument.id),
    content: text('content'),
    channel: text('channel').notNull().default('email'),
    isBreakup: boolean('is_breakup').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_fstep_strategy_seq').on(t.strategyId, t.seq),
    unique('uq_fstep_strategy_day').on(t.strategyId, t.dayOffset),
  ],
);

export const followUpTask = pgTable(
  'follow_up_task',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    customerId: text('customer_id')
      .notNull()
      .references(() => customer.id),
    strategyId: text('strategy_id')
      .notNull()
      .references(() => followUpStrategy.id),
    currentStage: followUpStage('current_stage').notNull().default('follow_up_1'),
    /** UTC 存储；写入值恒满足频控与窗口约束（07 v0.2.1 公式，单一写入口） */
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    status: followUpTaskStatus('status').notNull().default('ready'),
    lastExecutedAt: timestamp('last_executed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('uq_ftask_org_customer_strategy').on(t.orgId, t.customerId, t.strategyId),
    index('idx_ftask_schedule').on(t.orgId, t.status, t.nextRunAt),
  ],
);

export const followUpExecution = pgTable(
  'follow_up_execution',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    followUpTaskId: text('follow_up_task_id')
      .notNull()
      .references(() => followUpTask.id),
    strategyStepId: text('strategy_step_id').references(() => followUpStrategyStep.id),
    stepTitle: text('step_title').notNull(),
    status: fexecStatus('status').notNull(),
    content: text('content'),
    messageId: text('message_id').references(() => message.id),
    // FK→approval_request 由 manual 迁移补齐（08 建表后）
    approvalId: text('approval_id'),
    approvedBy: text('approved_by').references(() => userAccount.id),
    /** customer_replied / frequency_capped（07 §4 / §7） */
    skipReason: text('skip_reason'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_fexec_task').on(t.followUpTaskId, t.createdAt.desc()),
    index('idx_fexec_status').on(t.orgId, t.status),
  ],
);
