import type { Job, Processor } from 'bullmq';
import type { ResumeHint, TaskRunner } from '@tradepilot/runtime';
import { QUEUE_NAME, TASK_TYPE_QUEUE } from '@tradepilot/shared';
import type { Logger } from 'pino';

/** worker 内部装配依赖（index.ts 构建，避免循环 import queues/registry） */
export interface WorkerRuntime {
  runner: TaskRunner;
  logger: Logger;
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
    if (!TASK_QUEUES.has(job.queueName)) {
      return handleSystemJob(job, rt.logger);
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
 * 系统队列处理器（M3-12）：
 * - q:notify：通知分发随 M5 通知服务实装（后端开发计划表 M5 #11）；M3 仅 approval-expiry 等
 *   投递留痕（q:notify = 削峰占位，见 04 §1）。消费即 ack + info 留痕，防无主 job 堆积——
 *   代价：M3/M4 期间通知不送达（审批 expired 已有 approval_log 留痕，M5 实装发送端时另行收口）。
 * - q:email_sync：收信链路随 M4 邮箱驱动实装（MailboxSyncScheduler 届时投递，04 §3.1）；M3 无
 *   生产者，收到即说明链路提前接线 → warn 显式留痕。
 * 两者接入真实消费时替换本分支（04 §6.3 / M3-12 收口说明）。
 */
async function handleSystemJob(job: Job, logger: Logger): Promise<void> {
  const detail = { queue: job.queueName, jobId: job.id, data: job.data };
  if (job.queueName === QUEUE_NAME.EMAIL_SYNC) {
    logger.warn(detail, 'q:email_sync job 被消费（M3 无收信链路，随 M4 邮箱驱动实装）');
  } else {
    logger.info(
      detail,
      'q:notify job 被消费（M3 通知服务未实装，仅留痕；随 M5 通知服务实装发送端）',
    );
  }
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
