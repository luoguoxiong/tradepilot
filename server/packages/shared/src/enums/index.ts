/**
 * 全局枚举（接口总览 §3 / ER §4）。
 * TS 侧只用本文件常量对象（后端技术方案 01 §6.5），不得散落字面量。
 * 值统一为小写蛇形字符串，前端按语义色映射表渲染。
 */

/** 任务状态（00 §3.2） */
export const TASK_STATUS = {
  RUNNING: 'running',
  WAITING_APPROVAL: 'waiting_approval',
  SCHEDULED: 'scheduled',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELED: 'canceled',
} as const;
export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];

/** AI 员工状态（00 §3.1） */
export const EMPLOYEE_STATUS = {
  WORKING: 'working',
  WAITING_APPROVAL: 'waiting_approval',
  SCHEDULED: 'scheduled',
  RISK: 'risk',
  FAILED: 'failed',
  IDLE: 'idle',
} as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUS)[keyof typeof EMPLOYEE_STATUS];

/** 任务类型（14 §1.1，决定队列归属 04 §1） */
export const TASK_TYPE = {
  LEAD_HUNTING: 'lead_hunting',
  EMAIL_REPLY: 'email_reply',
  FOLLOW_UP: 'follow_up',
  ORDER_MONITOR: 'order_monitor',
  BUSINESS_ANALYSIS: 'business_analysis',
  KNOWLEDGE_INDEX: 'knowledge_index',
  PRODUCT_ANALYSIS: 'product_analysis',
} as const;
export type TaskType = (typeof TASK_TYPE)[keyof typeof TASK_TYPE];

/** 客户阶段（00 §3.3） */
export const CUSTOMER_STAGE = {
  NEW_LEAD: 'new_lead',
  CONTACTED: 'contacted',
  NEGOTIATION: 'negotiation',
  COLD: 'cold',
} as const;
export type CustomerStage = (typeof CUSTOMER_STAGE)[keyof typeof CUSTOMER_STAGE];

/** 客户价值分层（00 §3.4） */
export const LEAD_VALUE = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' } as const;
export type LeadValue = (typeof LEAD_VALUE)[keyof typeof LEAD_VALUE];

/** 审核类型（00 §3.5；riskLevel 分流见 Runtime §4.7） */
export const APPROVAL_TYPE = {
  QUOTE: 'quote',
  EMAIL_SEND: 'email_send',
  CONTRACT: 'contract',
  ORDER_CHANGE: 'order_change',
  BULK_MARKETING: 'bulk_marketing',
  CUSTOMER_DELETE: 'customer_delete',
} as const;
export type ApprovalType = (typeof APPROVAL_TYPE)[keyof typeof APPROVAL_TYPE];

/** 工具风险级别（ToolDefinition.riskLevel，Runtime §4.7） */
export const RISK_LEVEL = { LOW: 'low', MEDIUM: 'medium', HIGH: 'high' } as const;
export type RiskLevel = (typeof RISK_LEVEL)[keyof typeof RISK_LEVEL];

/**
 * 审批状态：接口总览 §3.5 基线 + auto_approved（自动审批留痕）+ expired（超时终态，04 §4）
 */
export const APPROVAL_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  EDITED_APPROVED: 'edited_approved',
  REJECTED: 'rejected',
  AUTO_APPROVED: 'auto_approved',
  EXPIRED: 'expired',
} as const;
export type ApprovalStatus = (typeof APPROVAL_STATUS)[keyof typeof APPROVAL_STATUS];

/** approval_log.action 取值（与 approval_status 同域） */
export const APPROVAL_LOG_ACTION = APPROVAL_STATUS;
export type ApprovalLogAction = ApprovalStatus;

/** 报价状态（00 §3.6，P1） */
export const QUOTE_STATUS = {
  DRAFT: 'draft',
  WAITING_APPROVAL: 'waiting_approval',
  SENT: 'sent',
  WON: 'won',
  LOST: 'lost',
} as const;
export type QuoteStatus = (typeof QUOTE_STATUS)[keyof typeof QUOTE_STATUS];

/** 订单状态（00 §3.6，P1） */
export const ORDER_STATUS = {
  PENDING_PAYMENT: 'pending_payment',
  IN_PRODUCTION: 'in_production',
  READY_TO_SHIP: 'ready_to_ship',
  COMPLETED: 'completed',
} as const;
export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

/** 订单风险（00 §3.6，P1） */
export const ORDER_RISK = { NORMAL: 'normal', AT_RISK: 'at_risk' } as const;
export type OrderRisk = (typeof ORDER_RISK)[keyof typeof ORDER_RISK];

/** 产品状态（00 §3.6，P1） */
export const PRODUCT_STATUS = { ACTIVE: 'active', DRAFT: 'draft', ARCHIVED: 'archived' } as const;
export type ProductStatus = (typeof PRODUCT_STATUS)[keyof typeof PRODUCT_STATUS];

/** 知识索引状态（00 §3.6） */
export const INDEX_STATUS = { INDEXED: 'indexed', INDEXING: 'indexing', FAILED: 'failed' } as const;
export type IndexStatus = (typeof INDEX_STATUS)[keyof typeof INDEX_STATUS];

/** 跟进任务状态（00 §3.6；Scheduler 仅扫 ready/scheduled） */
export const FOLLOW_UP_TASK_STATUS = {
  READY: 'ready',
  SCHEDULED: 'scheduled',
  WAITING_APPROVAL: 'waiting_approval',
  COMPLETED: 'completed',
  PAUSED: 'paused',
} as const;
export type FollowUpTaskStatus = (typeof FOLLOW_UP_TASK_STATUS)[keyof typeof FOLLOW_UP_TASK_STATUS];

/** 跟进执行跳过原因（07 / 04 §3.2） */
export const FOLLOW_UP_SKIP_REASON = { FREQUENCY_CAPPED: 'frequency_capped' } as const;
export type FollowUpSkipReason = (typeof FOLLOW_UP_SKIP_REASON)[keyof typeof FOLLOW_UP_SKIP_REASON];

/** 会话优先级（00 §3.6） */
export const CONVERSATION_PRIORITY = {
  HIGH: 'high',
  NORMAL: 'normal',
  PENDING: 'pending',
} as const;
export type ConversationPriority =
  (typeof CONVERSATION_PRIORITY)[keyof typeof CONVERSATION_PRIORITY];

/** 邮件意图（00 §3.6） */
export const AI_INTENT = {
  RFQ: 'rfq',
  PRICE_COMPARE: 'price_compare',
  LOGISTICS: 'logistics',
  SAMPLE: 'sample',
  OTHER: 'other',
} as const;
export type AiIntent = (typeof AI_INTENT)[keyof typeof AI_INTENT];

/** 角色基线（00 §3.6，16 §2.7） */
export const ROLE = { ADMIN: 'admin', MANAGER: 'manager', SALES: 'sales' } as const;
export type Role = (typeof ROLE)[keyof typeof ROLE];

/** 数据范围（接口总览 §4.4；应用层裁剪，不走 RLS） */
export const SCOPE = { SELF: 'self', TEAM: 'team', ALL: 'all' } as const;
export type Scope = (typeof SCOPE)[keyof typeof SCOPE];

/** 操作者身份（01 §6.6：service 层从上下文判定，不落参数） */
export const OPERATOR_TYPE = { AI: 'ai', USER: 'user' } as const;
export type OperatorType = (typeof OPERATOR_TYPE)[keyof typeof OPERATOR_TYPE];

/** 邮件方向（05 频控 L 取 out+sent） */
export const MESSAGE_DIRECTION = { IN: 'in', OUT: 'out' } as const;
export type MessageDirection = (typeof MESSAGE_DIRECTION)[keyof typeof MESSAGE_DIRECTION];

/** 邮件发送状态 */
export const MESSAGE_STATUS = {
  DRAFT: 'draft',
  PENDING: 'pending',
  SENT: 'sent',
  FAILED: 'failed',
} as const;
export type MessageStatus = (typeof MESSAGE_STATUS)[keyof typeof MESSAGE_STATUS];
