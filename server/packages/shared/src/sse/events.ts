/**
 * SSE 事件契约（接口文档 14 §3.4 + 后端技术方案 04 §6）。
 * Worker 写库后 Redis PUBLISH `task:{taskId}:events`；API 先订阅→按 after 回放→flush。
 * `seq` 为雪花字符串，供客户端去重。
 */
import { z } from 'zod';
import { TASK_STATUS } from '../enums/index.js';

export const SSE_EVENT_TYPE = {
  LOG: 'log',
  PROGRESS: 'progress',
  STATUS: 'status',
  DONE: 'done',
} as const;
export type SseEventType = (typeof SSE_EVENT_TYPE)[keyof typeof SSE_EVENT_TYPE];

/** event: log —— { "logId": "...", "time": "ISO", "type": "match", "content": "产品匹配度：92%" } */
export const sseLogPayloadSchema = z.object({
  logId: z.string().min(1),
  /** 事件时间（ISO8601 UTC）：与 /logs 单条 time 同源同构，实时与回放一致 */
  time: z.string().min(1),
  type: z.string().min(1),
  content: z.string(),
  leadId: z.string().min(1).optional(),
});
export type SseLogPayload = z.infer<typeof sseLogPayloadSchema>;

/** event: progress —— { "progressPct": 80, "currentStep": "分析公司官网" } */
export const sseProgressPayloadSchema = z.object({
  progressPct: z.number().int().min(0).max(100),
  currentStep: z.string(),
});
export type SseProgressPayload = z.infer<typeof sseProgressPayloadSchema>;

/** event: status —— { "status": "waiting_approval", "linkedApprovalId": "appr_30" } */
export const sseStatusPayloadSchema = z.object({
  status: z.enum([
    TASK_STATUS.RUNNING,
    TASK_STATUS.WAITING_APPROVAL,
    TASK_STATUS.SCHEDULED,
    TASK_STATUS.PAUSED,
    TASK_STATUS.FAILED,
    TASK_STATUS.CANCELED,
  ]),
  linkedApprovalId: z.string().min(1).optional(),
  error: z.string().optional(),
});
export type SseStatusPayload = z.infer<typeof sseStatusPayloadSchema>;

/** event: done —— { "status": "completed", "outputs": [...] } */
export const sseDonePayloadSchema = z.object({
  status: z.enum([TASK_STATUS.COMPLETED, TASK_STATUS.FAILED, TASK_STATUS.CANCELED]),
  outputs: z.array(z.unknown()).default([]),
  error: z.string().optional(),
});
export type SseDonePayload = z.infer<typeof sseDonePayloadSchema>;

/** 任务事件总线上的完整消息（Redis PUBLISH 载荷） */
export const taskEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(SSE_EVENT_TYPE.LOG),
    seq: z.string().min(1),
    payload: sseLogPayloadSchema,
  }),
  z.object({
    type: z.literal(SSE_EVENT_TYPE.PROGRESS),
    seq: z.string().min(1),
    payload: sseProgressPayloadSchema,
  }),
  z.object({
    type: z.literal(SSE_EVENT_TYPE.STATUS),
    seq: z.string().min(1),
    payload: sseStatusPayloadSchema,
  }),
  z.object({
    type: z.literal(SSE_EVENT_TYPE.DONE),
    seq: z.string().min(1),
    payload: sseDonePayloadSchema,
  }),
]);
export type TaskEvent = z.infer<typeof taskEventSchema>;

/** SSE 事件频道名（Worker → API） */
export function taskEventChannel(taskId: string): string {
  return `task:${taskId}:events`;
}
