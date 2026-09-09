/**
 * 05 CRM 客户中心 DTO（接口 05 §1.2/§3，M5-A4/B1）。
 * 软删/批量操作/contacts/activities 接 M5-B1。
 */
import { z } from 'zod';

export const CUSTOMER_STAGES = ['new_lead', 'contacted', 'negotiation', 'cold'] as const;
export type CustomerStage = (typeof CUSTOMER_STAGES)[number];

export const listCustomersQuerySchema = z.object({
  /** 客户身份页签（§3.1：potential=潜在 / formal=正式；contacts/activities 页签走 B1 独立接口） */
  tab: z.enum(['potential', 'formal']).optional(),
  country: z.string().trim().min(1).max(100).optional(),
  stage: z.enum(CUSTOMER_STAGES).optional(),
  ownerId: z.string().trim().min(1).optional(),
  scope: z.enum(['self', 'team', 'all']).optional(),
  /** 超期未联系天数（§1.1 筛选） */
  overdueDays: z.coerce.number().int().min(1).max(365).optional(),
});

export type ListCustomersQuery = z.infer<typeof listCustomersQuerySchema>;

const contactInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  title: z.string().trim().max(200).default(''),
  email: z.string().trim().email().optional(),
});

/** §1.2 添加客户表单（ownerId 缺省当前操作人；指定他人仅 manager/admin，越权 40301 在服务层校验） */
export const createCustomerSchema = z.object({
  companyName: z.string().trim().min(1).max(200),
  country: z.string().trim().min(1).max(100),
  website: z.string().trim().max(500).optional(),
  industry: z.string().trim().max(200).optional(),
  customerType: z.enum(['brand', 'distributor', 'factory', 'other']).optional(),
  isFormal: z.boolean().optional().default(false),
  stage: z.enum(CUSTOMER_STAGES).optional().default('new_lead'),
  ownerId: z.string().trim().min(1).optional(),
  contacts: z.array(contactInputSchema).max(50).optional(),
  remark: z.string().trim().max(2000).optional(),
});

export type CreateCustomerDto = z.infer<typeof createCustomerSchema>;

/** §2 编辑客户资料（stage 仅经 /stage 接口流转，不随 PUT 变更；ownerId 即转交，经理/管理员限定） */
export const updateCustomerSchema = z
  .object({
    companyName: z.string().trim().min(1).max(200).optional(),
    country: z.string().trim().min(1).max(100).optional(),
    website: z.string().trim().max(500).optional(),
    industry: z.string().trim().max(200).optional(),
    customerType: z.enum(['brand', 'distributor', 'factory', 'other']).optional(),
    isFormal: z.boolean().optional(),
    ownerId: z.string().trim().min(1).optional(),
    remark: z.string().trim().max(2000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少一项更新字段' });

export type UpdateCustomerDto = z.infer<typeof updateCustomerSchema>;

/** §3.2 阶段流转（正向或回退 contacted，非法 40901） */
export const stageTransitionSchema = z.object({
  stage: z.enum(CUSTOMER_STAGES),
  reason: z.string().trim().max(500).optional(),
});

export type StageTransitionDto = z.infer<typeof stageTransitionSchema>;

// ===== B1 新增 DTO =====

/** B1 §1 单条软删 / 批量删除 */
export const batchDeleteSchema = z.object({
  customerIds: z.array(z.string().trim().min(1)).min(1).max(100),
});

export type BatchDeleteDto = z.infer<typeof batchDeleteSchema>;

/** B1 §2 batch-owner 批量转交（仅 manager/admin） */
export const batchOwnerSchema = z.object({
  ownerId: z.string().trim().min(1),
  customerIds: z.array(z.string().trim().min(1)).min(1).max(100),
});

export type BatchOwnerDto = z.infer<typeof batchOwnerSchema>;

/** B1 §3 联系人创建 */
export const createContactSchema = z.object({
  name: z.string().trim().min(1).max(200),
  title: z.string().trim().max(200).default(''),
  email: z.string().trim().email().optional(),
  phone: z.string().trim().max(50).optional(),
  isPrimary: z.boolean().optional().default(false),
});

export type CreateContactDto = z.infer<typeof createContactSchema>;

/** B1 §3 联系人编辑 */
export const updateContactSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  title: z.string().trim().max(200).optional(),
  email: z.string().trim().email().optional(),
  phone: z.string().trim().max(50).optional(),
  isPrimary: z.boolean().optional(),
});

export type UpdateContactDto = z.infer<typeof updateContactSchema>;

/** B1 §4 活动列表查询 */
export const listActivitiesQuerySchema = z.object({
  refType: z.string().trim().min(1).optional(),
  refId: z.string().trim().min(1).optional(),
  type: z.enum([
    'stage_change',
    'owner_change',
    'email',
    'quote',
    'follow_up',
    'note',
    'ai_action',
  ]).optional(),
});

export type ListActivitiesQuery = z.infer<typeof listActivitiesQuerySchema>;