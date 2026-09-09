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
import { createToolRegistry, configureEmailSend, configureOrgSearchQuota } from '@tradepilot/tools';
import type { MailboxDriverOptions } from '@tradepilot/integrations';
import {
  configureEmbedding,
  configureObjectStorage,
  configureSearchProvider,
  createEmbeddingProvider,
  createS3Storage,
  createSearchProvider,
} from '@tradepilot/integrations';
import {
  createFlowRegistry,
  createOutputSchemaRegistry,
  createPromptRegistry,
  workflowSopProvider,
} from '@tradepilot/workflows';
import { createDb } from '@tradepilot/db';
import { loadEnv } from './env.js';
import { createRootLogger } from './logger.js';
import { createWorkers } from './queues/registry.js';
import { createProcessor } from './queues/processor.js';
import { EmailSyncProcessor } from './queues/email-sync.js';
import { KnowledgeIndexProcessor } from './queues/knowledge-index.js';
import { NotifyProcessor } from './queues/notify.js';
import { Dispatcher, DISPATCH_INTERVAL_MS } from './scheduler/dispatcher.js';
import { FollowUpScanner, FOLLOW_UP_SCAN_INTERVAL_MS } from './scheduler/follow-up-scanner.js';
import { MailboxSyncScheduler, MAILBOX_SYNC_INTERVAL_MS } from './scheduler/mailbox-sync.js';
import { ApprovalExpiryScanner, APPROVAL_EXPIRY_INTERVAL_MS } from './scheduler/approval-expiry.js';
import { DelayedJobReconciler, RECONCILE_INTERVAL_MS } from './scheduler/delayed-reconciler.js';
import { ZombieReaper, ZOMBIE_SCAN_INTERVAL_MS } from './scheduler/zombie-reaper.js';
import { QuotaResetScanner, QUOTA_RESET_INTERVAL_MS } from './scheduler/quota-reset.js';
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
  const enqueuer = new TaskEnqueuer(env.REDIS_URL);
  const gateway = new LlmGateway(db, logger, {
    provider: 'mock',
    defaultModel: 'mock-1',
    // M3-15：预算跨阈值超限 → q:notify（budget_limit；通知真实分发随 M5 #11，先入队留痕防静默吞）
    alert: (info) => {
      void enqueuer
        .enqueueNotify({ type: 'budget_limit', ...info })
        .catch((err: unknown) =>
          logger.warn(
            { orgId: info.orgId, err: err instanceof Error ? err.message : String(err) },
            '预算告警入队失败（不阻断 LLM 调用）',
          ),
        );
    },
  });
  const gate = new ApprovalGate(db, redis, publisher, logger, {
    // M5-A2：新建审批单 → q:notify（approval_pending；分发按 notification_setting 矩阵）
    onPendingApproval: (info) => {
      void enqueuer
        .enqueueNotify({
          type: 'approval_pending',
          orgId: info.orgId,
          title: `审批待处理：${info.title}`,
          content: `审批类型 ${info.approvalType}，关联任务 ${info.taskId}`,
          refType: 'approval',
          refId: info.approvalId,
        })
        .catch((err: unknown) =>
          logger.warn(
            { approvalId: info.approvalId, err: err instanceof Error ? err.message : String(err) },
            '审批待处理通知入队失败（不阻断）',
          ),
        );
    },
  });
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
  const runner = new TaskRunner({
    db,
    redis,
    logger,
    publisher,
    compiler,
    sops: workflowSopProvider,
    // M5-A2：任务失败 → q:notify（task_failed；分发按 notification_setting 矩阵）
    onTaskFailed: (info) => {
      void enqueuer
        .enqueueNotify({
          type: 'task_failed',
          orgId: info.orgId,
          title: `任务失败：${info.title}`,
          content: info.error,
          refType: 'task',
          refId: info.taskId,
        })
        .catch((err: unknown) =>
          logger.warn(
            { taskId: info.taskId, err: err instanceof Error ? err.message : String(err) },
            '任务失败通知入队失败（不阻断）',
          ),
        );
    },
  });

  // ===== 队列 =====
  // 邮箱驱动选项（M4 #4/#5：凭据解密主密钥 + OAuth 客户端，06 §2.4）
  const mailboxDriverOptions: MailboxDriverOptions = {
    encryptionKey: env.ENCRYPTION_KEY,
    oauth: {
      googleClientId: env.GOOGLE_CLIENT_ID || undefined,
      googleClientSecret: env.GOOGLE_CLIENT_SECRET || undefined,
      microsoftClientId: env.MICROSOFT_CLIENT_ID || undefined,
      microsoftClientSecret: env.MICROSOFT_CLIENT_SECRET || undefined,
    },
  };
  // email_send 真实外发唯一出口（06 §2.3）：tools 包进程级注入
  // （凭据解密 + OAuth 客户端 + 失败留痕独立事务连接）
  configureEmailSend({ ...mailboxDriverOptions, db });
  // M4 #6：搜索供应商适配 + org 级搜索日额度（06 §3）
  configureSearchProvider(
    createSearchProvider({
      provider: env.SEARCH_PROVIDER,
      baseUrl: env.SEARCH_BASE_URL,
      apiKey: env.SEARCH_API_KEY,
    }),
  );
  configureOrgSearchQuota(Number(process.env['ORG_SEARCH_DAILY_LIMIT'] || 0) || 2000);
  // M4 #7：嵌入服务 + S3 对象存储进程级注入（知识入库流水线 07 §2）
  configureEmbedding(
    createEmbeddingProvider({
      provider: env.EMBEDDING_PROVIDER,
      baseUrl: env.EMBEDDING_BASE_URL,
      apiKey: env.EMBEDDING_API_KEY,
      model: env.EMBEDDING_MODEL,
    }),
  );
  const storage = createS3Storage({
    endpoint: env.S3_ENDPOINT,
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  });
  configureObjectStorage(storage);
  const emailSync = new EmailSyncProcessor({
    db,
    redis,
    logger,
    driverOptions: mailboxDriverOptions,
  });
  const knowledgeIndex = new KnowledgeIndexProcessor({ db, logger });
  const notify = new NotifyProcessor({ db, logger, driverOptions: mailboxDriverOptions });
  const workers = createWorkers(
    env,
    env.REDIS_URL,
    logger,
    createProcessor({ runner, logger, emailSync, knowledgeIndex, notify }),
  );
  const summary = workers.map(
    (w) => `${w.name}(${QUEUE_CONCURRENCY[w.name as keyof typeof QUEUE_CONCURRENCY] ?? '?'})`,
  );

  // ===== 扫描循环（04 §3.1）=====
  const dispatcher = new Dispatcher({ db, enqueuer, logger });
  const followUpScanner = new FollowUpScanner({ db, logger });
  const mailboxSyncScheduler = new MailboxSyncScheduler({ db, enqueuer, logger });
  const approvalExpiry = new ApprovalExpiryScanner({ db, publisher, enqueuer, logger });
  const reconciler = new DelayedJobReconciler({ db, enqueuer, logger });
  const reaper = new ZombieReaper({ db, redis, publisher, logger });
  const quotaReset = new QuotaResetScanner({ db, redis, logger });
  const stopLoops = [
    startLoop('Dispatcher', DISPATCH_INTERVAL_MS, () => dispatcher.tick(), logger),
    startLoop('FollowUpScanner', FOLLOW_UP_SCAN_INTERVAL_MS, () => followUpScanner.tick(), logger),
    startLoop('MailboxSync', MAILBOX_SYNC_INTERVAL_MS, () => mailboxSyncScheduler.tick(), logger),
    startLoop('ApprovalExpiry', APPROVAL_EXPIRY_INTERVAL_MS, () => approvalExpiry.tick(), logger),
    startLoop('Reconciler', RECONCILE_INTERVAL_MS, () => reconciler.tick(), logger),
    startLoop('ZombieReaper', ZOMBIE_SCAN_INTERVAL_MS, () => reaper.tick(), logger),
    startLoop('QuotaReset', QUOTA_RESET_INTERVAL_MS, () => quotaReset.tick(), logger),
  ];

  logger.info(
    {
      queues: summary.length > 0 ? summary : ALL_QUEUES,
      schedulers: [
        'Dispatcher',
        'FollowUpScanner',
        'MailboxSync',
        'ApprovalExpiry',
        'Reconciler',
        'ZombieReaper',
        'QuotaReset',
      ],
      pid: process.pid,
    },
    'Worker 已启动（Runtime + 扫描循环就绪）',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, `收到 ${signal}，开始优雅停机（停扫描 → drain 当前 job → 关连接）`);
    // ① 停止领取新扫描（等待在跑 tick 结束；QuotaReset 已并入 stopLoops）
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
