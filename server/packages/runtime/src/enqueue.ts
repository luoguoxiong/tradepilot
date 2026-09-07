/**
 * 入队路径封装（后端技术方案 04 §1/§2）：
 * jobId=taskId（同 id 活跃 job 唯一，天然防重复入队）；removeOnComplete/removeOnFail 开启。
 * 四条入队路径（API 触发 / Scheduler 到期 / delayed job / 手动重试）统一经此封装。
 */
import { Queue } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
import { ALL_QUEUES, QUEUE_NAME, TASK_TYPE_QUEUE, type QueueName, type TaskType } from '@tradepilot/shared';

export interface EnqueueOptions {
  /** ai_task.scheduled_at 非空 → BullMQ delayed（04 §3.4） */
  delayMs?: number;
}

export class TaskEnqueuer {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(
    redisUrl: string,
    private readonly logger?: { warn(msg: string, err?: unknown): void },
  ) {
    for (const name of ALL_QUEUES) {
      this.queues.set(
        name,
        new Queue(name, {
          connection: new IORedis(redisUrl, { maxRetriesPerRequest: null }),
          defaultJobOptions: {
            removeOnComplete: { age: 3600, count: 1000 },
            removeOnFail: { age: 24 * 3600 },
            attempts: 1, // 04 §5.3：任务级不自动重投，失败走手动重试（retry_of 新任务）
          },
        }),
      );
    }
  }

  /** 按 task_type 路由队列投递（jobId=taskId） */
  async enqueueTask(taskId: string, taskType: TaskType, opts?: EnqueueOptions): Promise<void> {
    const queueName = TASK_TYPE_QUEUE[taskType];
    if (!queueName) {
      throw new Error(`task_type 无对应队列: ${taskType}`);
    }
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`队列未初始化: ${queueName}`);
    }
    await queue.add(taskType, { taskId, taskType }, {
      jobId: taskId,
      ...(opts?.delayMs !== undefined && opts.delayMs > 0 ? { delay: opts.delayMs } : {}),
    });
  }

  /** 任务取消/暂停 → 移除 delayed job（04 §3.4） */
  async removeTask(taskId: string, taskType: TaskType): Promise<void> {
    const queueName = TASK_TYPE_QUEUE[taskType];
    const queue = this.queues.get(queueName);
    if (!queue) {
      return;
    }
    const job = await queue.getJob(taskId);
    if (job) {
      await job.remove().catch((err: unknown) => {
        this.logger?.warn(`移除 job 失败: ${taskId}`, err);
      });
    }
  }

  /** 对账用：活跃 job 是否存在（DelayedJobReconciler，04 §3.1） */
  async hasActiveJob(taskId: string, taskType: TaskType): Promise<boolean> {
    const queueName = TASK_TYPE_QUEUE[taskType];
    const queue = this.queues.get(queueName);
    if (!queue) {
      return false;
    }
    const job = await queue.getJob(taskId);
    if (!job) {
      return false;
    }
    const state = await job.getState();
    return state === 'waiting' || state === 'active' || state === 'delayed';
  }

  /** notify 队列（削峰；通知服务随 M5 通知接口实装） */
  async enqueueNotify(payload: Record<string, unknown>): Promise<void> {
    const queue = this.queues.get(QUEUE_NAME.NOTIFY);
    if (!queue) {
      return;
    }
    await queue.add('notify', payload);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
  }
}
