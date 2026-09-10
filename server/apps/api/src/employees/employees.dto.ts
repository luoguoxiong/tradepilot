/**
 * 02 AI 数字员工中心 DTO（M5-C3）。
 * 契约来源：web/src/api/types/employees.ts（前端契约为唯一事实源）+ 页面级接口文档 02 §1.2。
 * - 角色/KPI metric 枚举（02 §1.1 注 + web mock 口径，联调 v0.1.8 统一）：
 *   lead_hunter=daily_leads / customer_researcher=daily_profiles / sales=daily_replies /
 *   follow_up=daily_followups / merchandiser=active_orders / manager=daily_reports；
 * - role / kpiConfig.metric / approvalPolicy.quote 属业务校验（非法 → 42201，服务层校验，02 §3.1/§3.2）；
 * - approvalPolicy.email_send 缺省 'high_value_only'、autoExecute 缺省 []（02 §1.2）。
 */
import { z } from 'zod';

export const EMPLOYEE_ROLES = [
  'lead_hunter',
  'customer_researcher',
  'sales',
  'follow_up',
  'merchandiser',
  'manager',
] as const;
export type EmployeeRole = (typeof EMPLOYEE_ROLES)[number];

/** 角色 → KPI metric 固定映射（02 §1.1 注 + web mock 口径；period 恒 daily） */
export const ROLE_KPI_METRIC: Record<EmployeeRole, string> = {
  lead_hunter: 'daily_leads',
  customer_researcher: 'daily_profiles',
  sales: 'daily_replies',
  follow_up: 'daily_followups',
  merchandiser: 'active_orders',
  manager: 'daily_reports',
};

export const approvalPolicySchema = z.object({
  /** 邮件发送审批策略（16 §4）：缺省跟随全局 high_value_only */
  email_send: z.enum(['always', 'high_value_only']).optional().default('high_value_only'),
  /** 报价动作为 6 类高风险动作红线（02 §3.2）：缺省/传 none → 42201（服务层校验） */
  quote: z.enum(['always', 'none']).optional(),
  autoExecute: z.array(z.string().trim().min(1)).max(100).default([]),
});

export const kpiConfigSchema = z.object({
  /** metric 须等于该角色枚举值（非法 → 42201，服务层校验，02 §3.2） */
  metric: z.string().trim().min(1),
  target: z.number().int().min(1),
  period: z.literal('daily'),
});

/** §1.2 创建 AI 员工（仅 admin/manager；分步向导 4 步一次提交） */
export const createEmployeeSchema = z.object({
  /** 角色须属于 6 角色枚举（非法 → 42201，服务层校验，02 §1.2） */
  role: z.string().trim().min(1),
  name: z.string().trim().min(1, '员工名称不能为空').max(200),
  goal: z.string().trim().min(1).max(2000),
  sopTemplateId: z.string().trim().min(1).optional(),
  sopParams: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  skills: z.array(z.string().trim().min(1)).max(50).default([]),
  tools: z.array(z.string().trim().min(1)).max(50).default([]),
  knowledgeScope: z.array(z.string().trim().min(1)).max(50).default([]),
  memoryConfig: z
    .object({
      retentionDays: z.number().int().min(1).max(3650).optional(),
      scope: z.string().trim().min(1).max(100).optional(),
    })
    .optional(),
  workflowId: z.string().trim().min(1).optional(),
  permissions: z.record(z.string(), z.boolean()).default({}),
  approvalPolicy: approvalPolicySchema,
  kpiConfig: kpiConfigSchema,
});

export type CreateEmployeeDto = z.infer<typeof createEmployeeSchema>;
