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
};

/** task_type → 队列 一对一映射 */
export const TASK_TYPE_QUEUE: Record<TaskType, QueueName> = {
  [TASK_TYPE.LEAD_HUNTING]: QUEUE_NAME.LEAD_HUNTING,
  [TASK_TYPE.EMAIL_REPLY]: QUEUE_NAME.EMAIL_REPLY,
  [TASK_TYPE.FOLLOW_UP]: QUEUE_NAME.FOLLOW_UP,
  [TASK_TYPE.KNOWLEDGE_INDEX]: QUEUE_NAME.KNOWLEDGE_INDEX,
  [TASK_TYPE.PRODUCT_ANALYSIS]: QUEUE_NAME.KNOWLEDGE_INDEX,
  [TASK_TYPE.BUSINESS_ANALYSIS]: QUEUE_NAME.ANALYSIS,
  [TASK_TYPE.ORDER_MONITOR]: QUEUE_NAME.ANALYSIS,
};

/** 全部队列名列表（worker 注册用） */
export const ALL_QUEUES = Object.values(QUEUE_NAME);
