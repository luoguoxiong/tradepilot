/**
 * BullMQ 队列拓扑（后端技术方案 04 §1）：task_type 与队列一对一映射。
 * 注意：BullMQ 禁止队列名含 ':'（Redis key 前缀分隔符），故采用 'q.' 前缀。
 */
import { TASK_TYPE, type TaskType } from '../enums/index.js';

export const QUEUE_NAME = {
  LEAD_HUNTING: 'q.lead_hunting',
  EMAIL_REPLY: 'q.email_reply',
  FOLLOW_UP: 'q.follow_up',
  KNOWLEDGE_INDEX: 'q.knowledge_index',
  ANALYSIS: 'q.analysis',
  EMAIL_SYNC: 'q.email_sync',
  NOTIFY: 'q.notify',
  /** 出站 Webhook 投递（16 FR-11 / 06 §5.2；由 q:notify 派生，独立队列承载 5 次指数退避重投） */
  WEBHOOK: 'q.webhook',
} as const;
export type QueueName = (typeof QUEUE_NAME)[keyof typeof QUEUE_NAME];

/** 每实例并发基线（04 §1） */
export const QUEUE_CONCURRENCY: Record<QueueName, number> = {
  [QUEUE_NAME.LEAD_HUNTING]: 2,
  [QUEUE_NAME.EMAIL_REPLY]: 5,
  [QUEUE_NAME.FOLLOW_UP]: 5,
  [QUEUE_NAME.KNOWLEDGE_INDEX]: 2,
  [QUEUE_NAME.ANALYSIS]: 1,
  [QUEUE_NAME.EMAIL_SYNC]: 3,
  [QUEUE_NAME.NOTIFY]: 5,
  [QUEUE_NAME.WEBHOOK]: 5,
};

/** task_type → 队列 一对一映射 */
export const TASK_TYPE_QUEUE: Record<TaskType, QueueName> = {
  [TASK_TYPE.LEAD_HUNTING]: QUEUE_NAME.LEAD_HUNTING,
  [TASK_TYPE.EMAIL_REPLY]: QUEUE_NAME.EMAIL_REPLY,
  [TASK_TYPE.FOLLOW_UP]: QUEUE_NAME.FOLLOW_UP,
  [TASK_TYPE.KNOWLEDGE_INDEX]: QUEUE_NAME.KNOWLEDGE_INDEX,
  [TASK_TYPE.PRODUCT_ANALYSIS]: QUEUE_NAME.KNOWLEDGE_INDEX,
  [TASK_TYPE.PRODUCT_KNOWLEDGE]: QUEUE_NAME.KNOWLEDGE_INDEX,
  [TASK_TYPE.BUSINESS_ANALYSIS]: QUEUE_NAME.ANALYSIS,
  [TASK_TYPE.ORDER_MONITOR]: QUEUE_NAME.ANALYSIS,
};

/** 全部队列名列表（worker 注册用） */
export const ALL_QUEUES = Object.values(QUEUE_NAME);

/** 承载 ai_task 的队列（同一队列可能同时承载系统 job，如 q:knowledge_index 的 docId 流水线） */
export const TASK_QUEUE_NAMES: readonly QueueName[] = [...new Set(Object.values(TASK_TYPE_QUEUE))];

/**
 * 任务级自动重投次数（04 §5.3 修订）。
 * 原口径 attempts=1（不自动重投，全靠手动 retry_of 新任务）对「外部依赖瞬时故障」不友好：
 * 一次连接超时就让整条任务停摆，已完成节点的成本也白费。
 * 现按 attempts=3（首次 + 2 次重投）+ 指数退避，**仅对可重试错误**生效（判定见 core
 * `isRetryableError`）；确定性失败（入参/权限/状态冲突/4xx）不重投，仍由 processor 正常收口。
 */
export const TASK_MAX_ATTEMPTS = 3;

/** 任务级重投退避基数 ms（BullMQ exponential：30s → 60s，含内置抖动） */
export const TASK_RETRY_BACKOFF_MS = 30_000;
