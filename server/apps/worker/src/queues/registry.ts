import { Worker, type Processor } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
import { ALL_QUEUES, QUEUE_CONCURRENCY, type QueueName } from '@tradepilot/shared';
import type { WorkerEnv } from '@tradepilot/shared';
import type { Logger } from 'pino';

/**
 * 队列注册表（后端技术方案 04 §1）。
 * 按 WORKER_QUEUES 过滤注册 Worker；processor 由 index.ts 装配（TaskRunner 执行 LangGraph 工作流）。
 * jobId = taskId（防重复入队）；removeOnComplete/removeOnFail 开启——痕迹在 DB 不在 Redis。
 */
const DEFAULT_JOB_OPTIONS = {
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 24 * 3600 },
} as const;

export function createWorkers(env: WorkerEnv, redisUrl: string, logger: Logger, processor: Processor): Worker[] {
  const known = (
    env.WORKER_QUEUES.length > 0
      ? ALL_QUEUES.filter((q) => env.WORKER_QUEUES.includes(q))
      : ALL_QUEUES
  ) as readonly QueueName[];

  return known.map((queueName) => {
    const worker = new Worker(queueName, processor, {
      // BullMQ 内部会复制连接；Worker 阻塞连接要求 maxRetriesPerRequest: null
      connection: new IORedis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true }),
      concurrency: QUEUE_CONCURRENCY[queueName],
      // 04 §1：长任务（lead_hunting/analysis 分钟级）给足 stalled 容忍
      stalledInterval: 60_000,
      maxStalledCount: 2,
    });
    worker.on('failed', (job, err) => {
      logger.error(
        { queue: queueName, jobId: job?.id, err: err.message },
        `任务失败: ${queueName}`,
      );
    });
    worker.on('error', (err) => {
      logger.error({ queue: queueName, err: err.message }, `Worker 错误: ${queueName}`);
    });
    return worker;
  });
}

export { DEFAULT_JOB_OPTIONS };
