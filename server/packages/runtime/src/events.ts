/**
 * 任务事件总线（后端技术方案 04 §6）：
 * Worker 写库后 Redis PUBLISH `task:{taskId}:events`；API 先订阅→after 回放→flush。
 * seq 为雪花字符串（Crockford 字典序=时间序，客户端去重游标）。
 */
import type { Redis } from 'ioredis';
import { Snowflake, encodeCrockford } from '@tradepilot/core';
import type { BufferedTaskEvent } from '@tradepilot/tools';
import {
  SSE_EVENT_TYPE,
  taskEventChannel,
  taskEventSchema,
  type TaskEvent,
} from '@tradepilot/shared';

/** 全局事件序号生成器（进程内单调） */
const seqSnowflake = new Snowflake(0n);

export function nextSeq(): string {
  return encodeCrockford(seqSnowflake.next());
}

export function buildLogEvent(payload: {
  logId: string;
  type: string;
  content: string;
  leadId?: string;
}): TaskEvent {
  return { type: SSE_EVENT_TYPE.LOG, seq: nextSeq(), payload } as unknown as TaskEvent;
}

export function buildProgressEvent(payload: { progressPct: number; currentStep: string }): TaskEvent {
  return { type: SSE_EVENT_TYPE.PROGRESS, seq: nextSeq(), payload } as unknown as TaskEvent;
}

export function buildStatusEvent(payload: {
  status: string;
  linkedApprovalId?: string;
  error?: string;
}): TaskEvent {
  return { type: SSE_EVENT_TYPE.STATUS, seq: nextSeq(), payload } as unknown as TaskEvent;
}

export function buildDoneEvent(payload: {
  status: string;
  outputs: Record<string, unknown>[];
  error?: string;
}): TaskEvent {
  return { type: SSE_EVENT_TYPE.DONE, seq: nextSeq(), payload } as unknown as TaskEvent;
}

/** Worker 侧发布器：写库 → PUBLISH（JSON 序列化，zod 校验保证契约） */
export class TaskEventPublisher {
  constructor(private readonly redis: Redis) {}

  async publish(taskId: string, event: TaskEvent): Promise<void> {
    const parsed = taskEventSchema.safeParse(event);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      throw new Error(`SSE 事件不符合契约: ${detail}；event=${JSON.stringify(event)}`);
    }
    await this.redis.publish(taskEventChannel(taskId), JSON.stringify(parsed.data));
  }

  /** 批量发布（节点事务提交后 flush 缓冲事件） */
  async publishAll(taskId: string, events: TaskEvent[]): Promise<void> {
    for (const event of events) {
      await this.publish(taskId, event);
    }
  }
}

/** 节点事务提交后：把缓冲事件转 TaskEvent（带 seq）并发布，随后清空缓冲 */
export async function flushBufferedEvents(
  publisher: TaskEventPublisher,
  taskId: string,
  buffered: BufferedTaskEvent[],
): Promise<void> {
  if (buffered.length === 0) {
    return;
  }
  const events: TaskEvent[] = buffered.map((e) => {
    if (e.type === 'log') {
      return buildLogEvent(e.payload as { logId: string; type: string; content: string; leadId?: string });
    }
    if (e.type === 'progress') {
      return buildProgressEvent(e.payload as { progressPct: number; currentStep: string });
    }
    if (e.type === 'status') {
      return buildStatusEvent(e.payload as { status: string; linkedApprovalId?: string; error?: string });
    }
    return buildDoneEvent(e.payload as { status: string; outputs: Record<string, unknown>[]; error?: string });
  });
  buffered.length = 0;
  await publisher.publishAll(taskId, events);
}
