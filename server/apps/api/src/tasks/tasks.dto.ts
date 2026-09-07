import { z } from 'zod';

/**
 * 任务中心契约（接口 14 §3 / 后端技术方案 04 §2）。
 * P0 范围：POST/GET /tasks、GET /{id}、logs?after=、steps、retry；
 * pause/resume/cancel/transfer-to-human 与 SSE stream 随 M3-15/M4 交付。
 */

/** 14 §3.2 通用新建：type 决定 SOP 与队列归属 */
export const createTaskSchema = z.object({
  employeeId: z.string().min(1),
  type: z.enum([
    'lead_hunting',
    'email_reply',
    'follow_up',
    'order_monitor',
    'business_analysis',
    'knowledge_index',
    'product_analysis',
  ]),
  title: z.string().trim().min(1, '任务名不能为空').max(200),
  input: z.record(z.unknown()).default({}),
  /** 定时触发（可选；UTC ISO，04 §3.4 delayed job） */
  scheduledAt: z.string().datetime().optional(),
});
export type CreateTaskDto = z.infer<typeof createTaskSchema>;

/** 14 §3.1 列表筛选（status Tab / employeeId / type） */
export const listTasksQuerySchema = z.object({
  status: z
    .enum(['running', 'waiting_approval', 'scheduled', 'completed', 'failed', 'paused', 'canceled'])
    .optional(),
  employeeId: z.string().min(1).optional(),
  type: z
    .enum([
      'lead_hunting',
      'email_reply',
      'follow_up',
      'order_monitor',
      'business_analysis',
      'knowledge_index',
      'product_analysis',
    ])
    .optional(),
});
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
