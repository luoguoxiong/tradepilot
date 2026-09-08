import type { Job, Processor } from 'bullmq';
import type { ResumeHint, TaskRunner } from '@tradepilot/runtime';
import { QUEUE_NAME, TASK_TYPE_QUEUE } from '@tradepilot/shared';
import type { Logger } from 'pino';
import type { EmailSyncProcessor } from './email-sync.js';
import type { KnowledgeIndexProcessor } from './knowledge-index.js';

/** worker 内部装配依赖（index.ts 构建，避免循环 import queues/registry） */
export interface WorkerRuntime {
  runner: TaskRunner;
  logger: Logger;
  /** q:email_sync 消费者（M4 #4 收信链路；缺省 = 邮箱同步未装配，留痕降级） */
  emailSync?: EmailSyncProcessor;
  /** q:knowledge_index 知识索引流水线消费者（M4 #7 RAG 入库；缺省 = 降级留痕） */
  knowledgeIndex?: KnowledgeIndexProcessor;
}

/**
 * 队列 processor（后端技术方案 04 §5.1）：BullMQ 领取 → 按队列分流执行。
 *
 * 分流（M3-12）：task_type 队列（TASK_TYPE_QUEUE 值域，job.id = ai_task.id）→
 * TaskRunner 执行 LangGraph 工作流；系统队列（q:email_sync / q:notify，不落 ai_task）→
 * 各自的系统处理器。避免全队列复用 runner.run——系统队列 job.id 不是任务 id，
 * 走 runner 只会误查落空（missing/skipped 静默吞掉载荷）。
 *
 * task job：job.data = { taskId, taskType }（enqueue.ts 投递契约）；审批 resume 场景随 job.data.resume 携带。
 * 返回 RunTaskResult（skipped/missing 亦为正常完成——痕迹在 DB，job 侧不重投，attempts=1）。
 */
export function createProcessor(rt: WorkerRuntime): Processor {
  return async (job: Job) => {
    // q:knowledge_index 双语义分流（M4 #7）：job.data.docId → 知识索引流水线（jobId=`kidx.{docId}`）；
    // 其余（job.id=ai_task.id，14 接口创建的 knowledge_index/product_analysis 任务）→ TaskRunner。
    if (
      job.queueName === QUEUE_NAME.KNOWLEDGE_INDEX &&
      typeof job.data?.['docId'] === 'string'
    ) {
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
    const result = await rt.runner.run(taskId, resume ? { resume } : undefined);
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
 * 系统队列处理器（M3-12 分流，M4/M5 接真实消费）：
 * - q:email_sync（M4 #4 实装）：job.data = { mailboxId }（enqueueEmailSync 投递契约）→
 *   EmailSyncProcessor 收信入库（conversation/message、跟进 pause、email_reply 任务派发）。
 * - q:notify：通知分发随 M5 通知服务实装；消费即 ack + info 留痕，防无主 job 堆积。
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
  rt.logger.info(
    { queue: job.queueName, jobId: job.id, data: job.data },
    'q:notify job 被消费（M3 通知服务未实装，仅留痕；随 M5 通知服务实装发送端）',
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
