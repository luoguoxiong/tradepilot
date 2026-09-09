/**
 * 06 AI 销售工作台 · 会话读侧 DTO（接口 06 §2/§3.1，M5-A3）。
 * 写侧（ai-draft / send / messages / ask-ai / suggestions）随 M5-C1/C2 交付。
 */
import { z } from 'zod';

/** query 布尔参数：仅认 'true'（'false'/缺省均视为未开启） */
const trueOnlyQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => v === 'true');

export const listConversationsQuerySchema = z.object({
  priority: z.enum(['high', 'normal', 'pending']).optional(),
  /** 仅未读会话（FR-01） */
  unreadOnly: trueOnlyQuery,
  /** 多邮箱来源筛选（FR-11） */
  mailboxId: z.string().min(1).optional(),
  /** 数据范围（缺省取角色上限，接口总览 §4.4） */
  scope: z.enum(['self', 'team', 'all']).optional(),
});

export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;
