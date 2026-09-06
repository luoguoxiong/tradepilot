import { ALL_QUEUES, QUEUE_CONCURRENCY } from '@tradepilot/shared';
import { loadEnv } from './env.js';
import { createRootLogger } from './logger.js';
import { createWorkers } from './queues/registry.js';

/**
 * Worker 启动入口（后端技术方案 04 §3 / 09 §2）：
 * env fail-fast → root logger → 按 WORKER_QUEUES 注册 BullMQ Worker → SIGTERM 优雅停机。
 * 雪花机器位 = WORKER_INDEX（02 §9，多实例按序分配）；Scheduler/Dispatcher 在 M3 落地。
 */
async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const logger = createRootLogger(env);

  const workers = createWorkers(env, env.REDIS_URL, logger);
  const summary = workers.map(
    (w) => `${w.name}(${QUEUE_CONCURRENCY[w.name as keyof typeof QUEUE_CONCURRENCY] ?? '?'})`,
  );

  logger.info(
    {
      queues: summary.length > 0 ? summary : ALL_QUEUES,
      pid: process.pid,
    },
    'Worker 已启动，等待任务',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, `收到 ${signal}，开始优雅停机（drain 当前任务后关闭）`);
    // 04 §5.4：SIGTERM → 停止取新任务，等待在跑 job 检查点落盘
    await Promise.allSettled(workers.map((w) => w.close()));
    logger.info('Worker 已关闭');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Worker 启动失败:', err);
  process.exit(1);
});
