/**
 * 分页 / 排序 / 筛选查询契约（接口总览 §2.3）。
 * 日志类增量接口例外：after={logId} 雪花游标（02 §8.3）。
 */
import { z } from 'zod';

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  keyword: z.string().trim().min(1).max(200).optional(),
  sortBy: z.string().trim().min(1).max(64).optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** 日志增量游标参数（14 §3.3） */
export const logAfterQuerySchema = z.object({
  after: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type LogAfterQuery = z.infer<typeof logAfterQuerySchema>;
