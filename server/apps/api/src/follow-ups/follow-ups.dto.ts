/**
 * 07-AI自动跟进 DTO（接口文档 07 §2/§3，M5-D1）。
 * 字段对齐前端契约 web/src/api/types/follow-up.ts（唯一事实源）。
 */
import { z } from 'zod';

/** 跟进任务列表查询（07 §3.2：tab/keyword/分页；keyword 已含于 paginationQuerySchema） */
export const listFollowUpTasksQuerySchema = z.object({
  tab: z.enum(['all', 'today', 'waiting_approval', 'completed']).optional(),
});

export type ListFollowUpTasksQuery = z.infer<typeof listFollowUpTasksQuerySchema>;

/** 策略步骤（ER 05 §2.5：templateId | content 二选一，channel MVP 固定 email） */
export const strategyStepSchema = z.object({
  seq: z.number().int().min(1),
  dayOffset: z.number().int().min(0).max(3650),
  title: z.string().trim().min(1).max(200),
  templateId: z.string().trim().min(1).optional(),
  content: z.string().trim().max(10_000).optional(),
  channel: z.literal('email').optional().default('email'),
  /** Break-up 节点系统置位并强制 manual_review（07 §2.1 设计说明 4） */
  isBreakup: z.boolean().optional().default(false),
});

export type StrategyStepDto = z.infer<typeof strategyStepSchema>;

/** 适用范围（07 §1.4；MVP 仅作标注与筛选，自动挂载 P1） */
export const targetScopeSchema = z.object({
  customerValue: z.array(z.enum(['high', 'medium', 'low'])).max(3).optional().default([]),
  industry: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
});

/**
 * 新建/编辑策略请求（07 §3.3；字段级 40001 由 ZodValidationPipe 兜底）。
 * 名称为空 / steps 为空属业务校验，放行到服务层统一抛 42201（对齐 mock validateStrategy），
 * 此处仅约束类型与长度上限。
 */
export const upsertStrategySchema = z.object({
  name: z.string().trim().max(100),
  targetScope: targetScopeSchema.optional().default({ customerValue: [] }),
  steps: z.array(strategyStepSchema).max(20),
  autoSendPolicy: z.enum(['manual_review', 'auto_send', 'value_based']),
  enabled: z.boolean().optional().default(true),
});

export type UpsertStrategyDto = z.infer<typeof upsertStrategySchema>;

/** 策略列表查询（keyword 命中策略名） */
export const listStrategiesQuerySchema = z.object({
  keyword: z.string().trim().min(1).max(200).optional(),
});

export type ListStrategiesQuery = z.infer<typeof listStrategiesQuerySchema>;

/** apply 应用策略到客户（07 §3.5：单选/批量；空数组 40001，最多 100） */
export const applyStrategySchema = z.object({
  customerIds: z.array(z.string().trim().min(1)).min(1).max(100),
});

export type ApplyStrategyDto = z.infer<typeof applyStrategySchema>;
