import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { aiEmployeeRole, employeeStatus, taskLogType, taskStatus, taskType } from './enums.js';
import { org, userAccount } from './01-org-user.js';

/**
 * ER 02 · AI 员工与任务模块（5 表）+ llm_call 记账增补（05 §6.4）。
 * ai_task.linked_approval_id 的 FK 由 manual 迁移补齐（08 建表后，ER 02 §3 注）。
 */

/** SOP content 结构（总纲 §4.3）：步骤/提示词/工具编排 + 高级设置参数 */
export interface SopContent {
  steps?: unknown[];
  prompts?: Record<string, unknown>;
  tools?: unknown[];
  advancedSettings?: Record<string, unknown>;
  [k: string]: unknown;
}

export const sopTemplate = pgTable('sop_template', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => org.id),
  role: aiEmployeeRole('role').notNull(),
  name: text('name').notNull(),
  content: jsonb('content').$type<SopContent>().notNull(),
  isPreset: boolean('is_preset').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export interface EmployeeApprovalPolicy {
  email_send: 'always' | 'high_value_only';
  quote: 'always';
  autoExecute: string[];
  [k: string]: unknown;
}

export interface EmployeeKpiConfig {
  metric: string;
  target: number;
  period: 'daily';
}

export const aiEmployee = pgTable(
  'ai_employee',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    role: aiEmployeeRole('role').notNull(),
    name: text('name').notNull(),
    avatar: text('avatar'),
    status: employeeStatus('status').notNull().default('idle'),
    statusDetail: text('status_detail'),
    goal: text('goal').notNull(),
    sopTemplateId: text('sop_template_id').references(() => sopTemplate.id),
    skills: text('skills').array().notNull().default([]),
    tools: text('tools').array().notNull().default([]),
    knowledgeScope: text('knowledge_scope').array().notNull().default([]),
    memoryConfig: jsonb('memory_config').$type<{ retentionDays?: number; scope?: string }>(),
    workflowId: text('workflow_id'),
    permissions: jsonb('permissions').$type<Record<string, unknown>>().notNull(),
    approvalPolicy: jsonb('approval_policy').$type<EmployeeApprovalPolicy>().notNull(),
    kpiConfig: jsonb('kpi_config').$type<EmployeeKpiConfig>().notNull(),
    createdBy: text('created_by').references(() => userAccount.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_ai_employee_org_role').on(t.orgId, t.role, t.status)],
);

export const aiTask = pgTable(
  'ai_task',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    employeeId: text('employee_id')
      .notNull()
      .references(() => aiEmployee.id),
    type: taskType('type').notNull(),
    title: text('title').notNull(),
    // 默认 scheduled：running 由 Runner.claim 独占置位并补 started_at（04 §5.2），
    // 避免未来误插入「running + started_at 空」的不可恢复直投态（M3-01 根因同源，M3-17）
    status: taskStatus('status').notNull().default('scheduled'),
    progressPct: smallint('progress_pct').notNull().default(0),
    currentStep: text('current_step'),
    input: jsonb('input').$type<Record<string, unknown>>().notNull().default({}),
    outputs: jsonb('outputs').$type<Record<string, unknown>[]>(),
    error: text('error'),
    // FK→approval_request 由 manual 迁移补齐（08 建表后）
    linkedApprovalId: text('linked_approval_id'),
    retryOf: text('retry_of').references((): AnyPgColumn => aiTask.id),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdBy: text('created_by').references(() => userAccount.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('ck_task_progress', sql`${t.progressPct} BETWEEN 0 AND 100`),
    index('idx_ai_task_org_status').on(t.orgId, t.status, t.createdAt.desc()),
    index('idx_ai_task_org_employee').on(t.orgId, t.employeeId, t.createdAt.desc()),
    index('idx_ai_task_org_type').on(t.orgId, t.type),
  ],
);

export const aiTaskStep = pgTable(
  'ai_task_step',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    taskId: text('task_id')
      .notNull()
      .references(() => aiTask.id),
    seq: smallint('seq').notNull(),
    name: text('name').notNull(),
    status: taskStatus('status').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [unique('uq_task_step_task_seq').on(t.taskId, t.seq)],
);

export const aiTaskLog = pgTable(
  'ai_task_log',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    taskId: text('task_id')
      .notNull()
      .references(() => aiTask.id),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    type: taskLogType('type').notNull(),
    content: text('content').notNull(),
    leadId: text('lead_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_ai_task_log_task').on(t.taskId, t.occurredAt)],
);

/** llm_call（05 §6.4 增补表；数据中心 15 成本报表数据源） */
export const llmCall = pgTable(
  'llm_call',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => org.id),
    taskId: text('task_id').references(() => aiTask.id),
    employeeId: text('employee_id').references(() => aiEmployee.id),
    node: text('node').notNull(),
    scene: text('scene'),
    model: text('model').notNull(),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    latencyMs: integer('latency_ms'),
    degraded: boolean('degraded').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_llm_call_org_time').on(t.orgId, t.createdAt.desc())],
);
