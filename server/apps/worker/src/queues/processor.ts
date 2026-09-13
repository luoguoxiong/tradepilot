import type { Job, Processor } from 'bullmq';
import type { ResumeHint, TaskRunner } from '@tradepilot/runtime';
import { notifyJobSchema, QUEUE_NAME, TASK_TYPE_QUEUE, webhookJobSchema } from '@tradepilot/shared';
import type { Logger } from 'pino';
import type { EmailSyncProcessor } from './email-sync.js';
import type { KnowledgeIndexProcessor } from './knowledge-index.js';
import type { NotifyProcessor } from './notify.js';
import type { WebhookDeliveryProcessor } from './webhook.js';

/** worker 内部装配依赖（index.ts 构建，避免循环 import queues/registry） */
export interface WorkerRuntime {
  runner: TaskRunner;
  logger: Logger;
  /** q:email_sync 消费者（M4 #4 收信链路；缺省 = 邮箱同步未装配，留痕降级） */
  emailSync?: EmailSyncProcessor;
  /** q:knowledge_index 知识索引流水线消费者（M4 #7 RAG 入库；缺省 = 降级留痕） */
  knowledgeIndex?: KnowledgeIndexProcessor;
  /** q:notify 通知分发消费者（M5-A2 通知服务；缺省 = 降级留痕） */
  notify?: NotifyProcessor;
  /** q:webhook 出站投递消费者（P1-X-21；缺省 = 降级留痕） */
  webhook?: WebhookDeliveryProcessor;
}

/**
 * 队列 processor（后端技术方案 04 §5.1）：BullMQ 领取 → 按队列分流执行。
 *
 * 分流（M3-12）：task_type 队列（TASK_TYPE_QUEUE 值域，job.id = ai_task.id）→
 * TaskRunner 执行 LangGraph 工作流；系统队列（q:email_sync / q:notify，不落 ai_task）→
 * 各自的系统处理器。避免全队列复用 runner.run——系统队列 job.id 不是任务 id，
 * 走 runner 只会误查落空（missing/skipped 静默吞掉载荷）。
 *
 * task job：job.data = { taskId, taskType }（enqueue.ts 投递契约）；审批 resume 场景随 job.data.resume 携带，
 * 手动恢复场景随 job.data.fromPause 携带（P1-X-30）。
 * 返回 RunTaskResult（skipped/missing 亦为正常完成——痕迹在 DB，job 侧不重投，attempts=1）。
 */
export function createProcessor(rt: WorkerRuntime): Processor {
  return async (job: Job) => {
    // q:knowledge_index 双语义分流（M4 #7）：job.data.docId → 知识索引流水线（jobId=`kidx.{docId}`）；
    // 其余（job.id=ai_task.id，14 接口创建的 knowledge_index/product_analysis 任务）→ TaskRunner。
    if (job.queueName === QUEUE_NAME.KNOWLEDGE_INDEX && typeof job.data?.['docId'] === 'string') {
      if (!rt.knowledgeIndex) {
        rt.logger.warn(
          { queue: job.queueName, jobId: job.id, docId: job.data?.['docId'] },
          'q:knowledge_index job 被消费但索引流水线未装配（降级留痕）',
        );
        return undefined;
      }
      const outcome = await rt.knowledgeIndex.process(String(job.data['docId']));
      rt.logger.info({ queue: job.queueName, ...outcome }, '知识索引 job 处理结束');
      return outcome;
    }
    if (!TASK_QUEUES.has(job.queueName)) {
      return handleSystemJob(job, rt);
    }
    const taskId = String(job.id);
    const resumeRaw: unknown = job.data?.['resume'];
    const resume = isResumeHint(resumeRaw) ? (resumeRaw as unknown as ResumeHint) : undefined;
    // 手动恢复（P1-X-30 / 04 §5.4）：job.data.fromPause=true → Runner 从最近检查点续跑
    const fromPause = job.data?.['fromPause'] === true;
    const runOpts: { resume?: ResumeHint; fromPause?: boolean } = {};
    if (resume) {
      runOpts.resume = resume;
    }
    if (fromPause) {
      runOpts.fromPause = true;
    }
    const result = await rt.runner.run(
      taskId,
      Object.keys(runOpts).length > 0 ? runOpts : undefined,
    );
    rt.logger.info(
      { queue: job.queueName, taskId, status: result.status, error: result.error },
      '任务 job 处理结束',
    );
    return result;
  };
}

/** 承载 ai_task 的队列名集合（其余为系统队列） */
const TASK_QUEUES = new Set<string>(Object.values(TASK_TYPE_QUEUE));

/**
 * 系统队列处理器（M3-12 分流）：
 * - q:email_sync（M4 #4 实装）：job.data = { mailboxId }（enqueueEmailSync 投递契约）→
 *   EmailSyncProcessor 收信入库（conversation/message、跟进 pause、email_reply 任务派发）。
 * - q:notify（M5-A2 实装）：NotifyJob 载荷 → NotifyProcessor 按 notification_setting 分发
 *   （site 站内落库 / email 接邮箱驱动，另派生 q:webhook 出站）；畸形载荷留痕跳过，不抛错重投。
 * - q:webhook（P1-X-21 实装）：WebhookJob 载荷 → 回库解密 secret → POST + HMAC 签名；
 *   畸形载荷留痕跳过（不重投），投递失败**向外抛出**由 BullMQ 按 attempts=5 指数退避重投（06 §5.2）。
 */
async function handleSystemJob(job: Job, rt: WorkerRuntime): Promise<void> {
  if (job.queueName === QUEUE_NAME.EMAIL_SYNC) {
    if (!rt.emailSync) {
      rt.logger.warn(
        { queue: job.queueName, jobId: job.id, data: job.data },
        'q:email_sync job 被消费但邮箱同步处理器未装配（降级留痕）',
      );
      return undefined;
    }
    const mailboxId = String(job.data?.['mailboxId'] ?? '');
    if (!mailboxId) {
      rt.logger.warn(
        { queue: job.queueName, jobId: job.id },
        'q:email_sync job 缺少 mailboxId，跳过',
      );
      return undefined;
    }
    const outcome = await rt.emailSync.process(mailboxId);
    rt.logger.info({ queue: job.queueName, ...outcome }, '邮箱同步 job 处理结束');
    return undefined;
  }
  if (job.queueName === QUEUE_NAME.WEBHOOK) {
    if (!rt.webhook) {
      rt.logger.warn(
        { queue: job.queueName, jobId: job.id, data: job.data },
        'q:webhook job 被消费但出站投递处理器未装配（降级留痕）',
      );
      return undefined;
    }
    const parsed = webhookJobSchema.safeParse(job.data);
    if (!parsed.success) {
      rt.logger.warn(
        { queue: job.queueName, jobId: job.id, data: job.data, issues: parsed.error.issues },
        'q:webhook 载荷畸形，留痕跳过',
      );
      return undefined;
    }
    // 投递失败不吞：抛出交由 BullMQ 按 attempts + exponential backoff 重投（末次失败在处理器内打死信标记）
    const outcome = await rt.webhook.process(parsed.data, {
      attemptsMade: job.attemptsMade,
      attempts: job.opts?.attempts ?? 1,
    });
    rt.logger.info({ queue: job.queueName, ...outcome }, 'Webhook 投递 job 处理结束');
    return undefined;
  }
  if (job.queueName === QUEUE_NAME.NOTIFY) {
    if (!rt.notify) {
      rt.logger.warn(
        { queue: job.queueName, jobId: job.id, data: job.data },
        'q:notify job 被消费但通知处理器未装配（降级留痕）',
      );
      return undefined;
    }
    const parsed = notifyJobSchema.safeParse(job.data);
    if (!parsed.success) {
      rt.logger.warn(
        { queue: job.queueName, jobId: job.id, data: job.data, issues: parsed.error.issues },
        'q:notify 载荷畸形，留痕跳过',
      );
      return undefined;
    }
    const outcome = await rt.notify.process(parsed.data);
    rt.logger.info({ queue: job.queueName, ...outcome }, '通知 job 处理结束');
    return undefined;
  }
  rt.logger.warn(
    { queue: job.queueName, jobId: job.id, data: job.data },
    '未知系统队列 job，留痕跳过',
  );
  return undefined;
}

function isResumeHint(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['nodeId'] === 'string' &&
    typeof (value as Record<string, unknown>)['approvalId'] === 'string'
  );
}
