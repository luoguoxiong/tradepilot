import { z } from 'zod';

/**
 * 任务中心契约（接口 14 §3 / 后端技术方案 04 §2）。
 * P0 范围：POST/GET /tasks、GET /{id}、logs?after=、steps、retry；
 * pause/resume/cancel/transfer-to-human（P1-X-30~31）与失败批量处理（P1-X-33）随本轮交付；
 * SSE stream 见 sse.controller。
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
    'product_knowledge',
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
      'product_knowledge',
    ])
    .optional(),
});
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

/**
 * 转人工（P1-X-31 / 14 §3.6）：暂停图 + 写 outputs 交接摘要（handoff）。
 * 全部字段可选——缺省即「无补充说明的人工接管」。
 */
export const transferToHumanSchema = z.object({
  /** 转人工原因（缺省不填） */
  reason: z.string().trim().max(500).optional(),
  /** 期望承接人 / 团队（自由文本，P1 仅留痕不派单） */
  assignee: z.string().trim().max(100).optional(),
  /** 交接摘要（人工补充，缺省由服务侧按任务信息生成） */
  summary: z.string().trim().max(2000).optional(),
});
export type TransferToHumanDto = z.infer<typeof transferToHumanSchema>;

/** 失败批量处理（P1-X-33 / 14 §3.7）：多选重试（retry→新任务）/ 转人工，单次 1..50 */
export const batchTaskActionSchema = z.object({
  action: z.enum(['retry', 'transfer_to_human']),
  taskIds: z.array(z.string().min(1)).min(1, '至少选择 1 个任务').max(50, '单次最多 50 个任务'),
  /** transfer_to_human 可携带统一原因 */
  reason: z.string().trim().max(500).optional(),
});
export type BatchTaskActionDto = z.infer<typeof batchTaskActionSchema>;
