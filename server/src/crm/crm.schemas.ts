import { z } from 'zod';

export const CRM_STATUSES = ['NEW', 'QUALIFIED', 'CONTACTED', 'REPLIED', 'NEGOTIATING', 'WON', 'LOST'] as const;
export type CrmStatusValue = (typeof CRM_STATUSES)[number];

/**
 * 状态机（PRD §3.6）：New → Qualified → Contacted → Replied → Negotiating → Won / Lost。
 * 仅允许前进；LOST 允许从 QUALIFIED 起退出；WON 仅可从 NEGOTIATING 达成；终态不可再流转。
 * 非法跳转（如 NEW→WON、NEW→LOST、回退）一律 400 INVALID_TRANSITION。
 */
export const ALLOWED_TRANSITIONS: Record<CrmStatusValue, CrmStatusValue[]> = {
  NEW: ['QUALIFIED'],
  QUALIFIED: ['CONTACTED', 'LOST'],
  CONTACTED: ['REPLIED', 'LOST'],
  REPLIED: ['NEGOTIATING', 'LOST'],
  NEGOTIATING: ['WON', 'LOST'],
  WON: [],
  LOST: [],
};

export const ListCustomersQuerySchema = z.object({
  status: z.enum(CRM_STATUSES).optional(),
  q: z.string().trim().max(120).optional(),
  dueWithinDays: z.coerce.number().int().min(0).max(365).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const TransitionSchema = z.object({
  to: z.enum(CRM_STATUSES),
  note: z.string().trim().max(500).optional(),
});

export const AddActivitySchema = z.object({
  type: z.enum(['NOTE', 'STATUS_CHANGE', 'FOLLOW_UP']),
  content: z.string().trim().min(1, 'content is required').max(2000),
  nextFollowUpAt: z.coerce.date().optional(),
});

export type ListCustomersQuery = z.infer<typeof ListCustomersQuerySchema>;
