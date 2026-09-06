import { Redis as IORedis } from 'ioredis';
import { ALL_QUEUES, QUEUE_CONCURRENCY } from '@tradepilot/shared';
import {
  ApprovalGate,
  GraphCompiler,
  LlmGateway,
  TaskEnqueuer,
  TaskEventPublisher,
  TaskRunner,
  createCheckpointer,
} from '@tradepilot/runtime';
import { createToolRegistry } from '@tradepilot/tools';
import {
  createFlowRegistry,
  createOutputSchemaRegistry,
  createPromptRegistry,
  workflowSopProvider,
} from '@tradepilot/workflows';
import { createDb, closeDb } from '@tradepilot/db';
import { loadEnv } from './env.js';
import { createRootLogger } from './logger.js';
import { createWorkers } from './queues/registry.js';
import { createProcessor } from './queues/processor.js';
import { Dispatcher, DISPATCH_INTERVAL_MS } from './scheduler/dispatcher.js';
import { FollowUpScanner, FOLLOW_UP_SCAN_INTERVAL_MS } from './scheduler/follow-up-scanner.js';
import { ApprovalExpiryScanner, APPROVAL_EXPIRY_INTERVAL_MS } from './scheduler/approval-expiry.js';
import { DelayedJobReconciler, RECONCILE_INTERVAL_MS } from './scheduler/delayed-reconciler.js';
import { ZombieReaper, ZOMBIE_SCAN_INTERVAL_MS } from './scheduler/zombie-reaper.js';
import { startQuotaResetLoop } from './scheduler/quota-reset.js';
import { startLoop } from './scheduler/loop.js';

/**
 * Worker 启动入口（后端技术方案 04 §3 / 05 §2 / 09 §2）：
 * env fail-fast → DB 双连接（业务 + langgraph checkpointer）→ Runtime 装配
 * （ToolRegistry / LLM Gateway mock / Approval Gate / GraphCompiler / TaskRunner / workflows 三注册表）
 * → BullMQ Worker（真 processor）→ 扫描循环（Dispatcher/FollowUpScanner/审批超时/对账/僵尸/配额）
 * → SIGTERM 优雅停机（停扫描 → drain job → 关连接）。
 */
async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const logger = createRootLogger(env);

  // ===== 连接 =====
  const db = createDb(env.DATABASE_URL);
  const redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const publisher = new TaskEventPublisher(redis);
  // checkpointer 独立连接（search_path=langgraph，setup 建表随 manual 迁移授权）
  const checkpointer = await createCheckpointer(env.DATABASE_URL);

  // ===== Runtime 装配 =====
  // M3 LLM 走 mock provider（Zod 驱动确定性产出，三工作流全链路可测）；真实 provider 随 M4
  const gateway = new LlmGateway(db, logger, { provider: 'mock', defaultModel: 'mock-1' });
  const gate = new ApprovalGate(db, redis, publisher, logger);
  const tools = createToolRegistry();
  const compiler = new GraphCompiler({
    db,
    redis,
    logger,
    publisher,
    gateway,
    gate,
    tools,
    flows: createFlowRegistry(),
    prompts: createPromptRegistry(),
    outputSchemas: createOutputSchemaRegistry(),
    checkpointer: checkpointer.saver,
  });
  const runner = new TaskRunner({ db, redis, logger, publisher, compiler, sops: workflowSopProvider });
  const enqueuer = new TaskEnqueuer(env.REDIS_URL);

  // ===== 队列 =====
  const workers = createWorkers(env, env.REDIS_URL, logger, createProcessor({ runner, logger }));
  const summary = workers.map(
    (w) => `${w.name}(${QUEUE_CONCURRENCY[w.name as keyof typeof QUEUE_CONCURRENCY] ?? '?'})`,
  );

  // ===== 扫描循环（04 §3.1）=====
  const dispatcher = new Dispatcher({ db, enqueuer, logger });
  const followUpScanner = new FollowUpScanner({ db, logger });
  const approvalExpiry = new ApprovalExpiryScanner({ db, publisher, enqueuer, logger });
  const reconciler = new DelayedJobReconciler({ db, enqueuer, logger });
  const reaper = new ZombieReaper({ db, redis, publisher, logger });
  const stopLoops = [
    startLoop('Dispatcher', DISPATCH_INTERVAL_MS, () => dispatcher.tick(), logger),
    startLoop('FollowUpScanner', FOLLOW_UP_SCAN_INTERVAL_MS, () => followUpScanner.tick(), logger),
    startLoop('ApprovalExpiry', APPROVAL_EXPIRY_INTERVAL_MS, () => approvalExpiry.tick(), logger),
    startLoop('Reconciler', RECONCILE_INTERVAL_MS, () => reconciler.tick(), logger),
    startLoop('ZombieReaper', ZOMBIE_SCAN_INTERVAL_MS, () => reaper.tick(), logger),
  ];
  const stopQuota = startQuotaResetLoop(logger);

  logger.info(
    {
      queues: summary.length > 0 ? summary : ALL_QUEUES,
      schedulers: ['Dispatcher', 'FollowUpScanner', 'ApprovalExpiry', 'Reconciler', 'ZombieReaper', 'QuotaReset'],
      pid: process.pid,
    },
    'Worker 已启动（Runtime + 扫描循环就绪）',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, `收到 ${signal}，开始优雅停机（停扫描 → drain 当前 job → 关连接）`);
    stopQuota();
    // ① 停止领取新扫描（等待在跑 tick 结束）
    await Promise.allSettled(stopLoops.map((stop) => stop()));
    // ② 04 §5.4：停止取新 job，等待在跑 job 检查点落盘（BullMQ close 内置 drain）
    await Promise.allSettled(workers.map((w) => w.close()));
    // ③ 关闭连接
    await Promise.allSettled([enqueuer.close(), checkpointer.close(), redis.quit() as unknown]);
    await import('@tradepilot/db').then((m) => m.closeDb(db));
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
