import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * 全局枚举（ER 00 §4，与接口总览 §3 严格一致；名称即 CREATE TYPE 名）。
 * 后续新增取值用 ALTER TYPE ... ADD VALUE 迁移，禁止改字面量。
 */

// AI 员工与任务
export const employeeStatus = pgEnum('employee_status', [
  'working',
  'waiting_approval',
  'scheduled',
  'risk',
  'failed',
  'idle',
]);
export const aiEmployeeRole = pgEnum('ai_employee_role', [
  'lead_hunter',
  'customer_researcher',
  'sales',
  'follow_up',
  'merchandiser',
  'manager',
]);
export const taskStatus = pgEnum('task_status', [
  'running',
  'waiting_approval',
  'scheduled',
  'paused',
  'completed',
  'failed',
  'canceled',
]);
export const taskType = pgEnum('task_type', [
  'lead_hunting',
  'email_reply',
  'follow_up',
  'order_monitor',
  'business_analysis',
  'knowledge_index',
  'product_analysis',
]);
export const taskLogType = pgEnum('task_log_type', [
  'search',
  'found',
  'crawl',
  'match',
  'contact',
  'lookup',
  'error',
]);

// 客户与获客
export const leadValue = pgEnum('lead_value', ['high', 'medium', 'low']);
export const customerStage = pgEnum('customer_stage', [
  'new_lead',
  'contacted',
  'negotiation',
  'cold',
]);
export const customerType = pgEnum('customer_type', ['brand', 'distributor', 'factory', 'other']);
export const activityType = pgEnum('activity_type', [
  'stage_change',
  'owner_change',
  'email',
  'quote',
  'follow_up',
  'note',
  'ai_action',
]);
export const operatorType = pgEnum('operator_type', ['ai', 'user']);
export const insightType = pgEnum('insight_type', [
  'purchase_probability',
  'reactivation',
  'product_match',
  'pricing',
  'order_risk',
]);

// 销售与跟进
export const conversationPriority = pgEnum('conversation_priority', ['high', 'normal', 'pending']);
export const aiIntent = pgEnum('ai_intent', [
  'rfq',
  'price_compare',
  'logistics',
  'sample',
  'other',
]);
export const msgDirection = pgEnum('msg_direction', ['in', 'out']);
export const msgStatus = pgEnum('msg_status', ['draft', 'sent', 'failed']);
export const senderType = pgEnum('sender_type', ['ai', 'user', 'contact']);
export const followUpStage = pgEnum('follow_up_stage', [
  'follow_up_1',
  'follow_up_2',
  'follow_up_3',
  'quote_followup',
]);
export const followUpTaskStatus = pgEnum('follow_up_task_status', [
  'ready',
  'scheduled',
  'waiting_approval',
  'completed',
  'paused',
]);
export const fexecStatus = pgEnum('fexec_status', [
  'sent',
  'waiting_approval',
  'approved',
  'rejected',
  'failed',
  'skipped',
]);
export const autoSendPolicy = pgEnum('auto_send_policy', [
  'manual_review',
  'auto_send',
  'value_based',
]);

// 产品与知识
export const productStatus = pgEnum('product_status', ['active', 'draft', 'archived']);
export const productDocType = pgEnum('product_doc_type', [
  'catalog',
  'certification',
  'test_report',
  'other',
]);
export const knowledgeCategory = pgEnum('knowledge_category', [
  'product',
  'company',
  'sales',
  'customer',
  'faq',
  'process',
  'other',
]);
export const indexStatus = pgEnum('index_status', ['indexed', 'indexing', 'failed']);
export const knowledgeSearchScene = pgEnum('knowledge_search_scene', [
  'lead_match',
  'sales_reply',
  'follow_up',
  'pricing_basis',
  'business_analysis',
]);

// 报价与订单
export const quoteStatus = pgEnum('quote_status', [
  'draft',
  'waiting_approval',
  'sent',
  'won',
  'lost',
]);
export const orderStatus = pgEnum('order_status', [
  'pending_payment',
  'in_production',
  'ready_to_ship',
  'completed',
]);
export const orderRisk = pgEnum('order_risk', ['normal', 'at_risk']);

// 审批
export const approvalType = pgEnum('approval_type', [
  'quote',
  'email_send',
  'contract',
  'order_change',
  'bulk_marketing',
  'customer_delete',
]);
export const approvalStatus = pgEnum('approval_status', [
  'pending',
  'auto_approved',
  'approved',
  'edited_approved',
  'rejected',
  'expired',
]);
export const riskLevel = pgEnum('risk_level', ['high', 'medium', 'low']);

// 组织与设置
export const userRole = pgEnum('user_role', ['admin', 'manager', 'sales']);
export const memberStatus = pgEnum('member_status', ['active', 'disabled', 'invited']);
export const mailboxProvider = pgEnum('mailbox_provider', ['gmail', 'outlook', 'smtp_imap']);
export const mailboxStatus = pgEnum('mailbox_status', ['connected', 'error', 'disconnected']);

// 经理与报告
export const discoveryType = pgEnum('discovery_type', ['opportunity', 'risk']);
export const reportPeriod = pgEnum('report_period', ['daily', 'weekly', 'monthly']);
export const reportStatus = pgEnum('report_status', ['generating', 'ready', 'failed']);
