import { Redis as IORedis } from 'ioredis';
import type { Job, Processor } from 'bullmq';
import type { ResumeHint, TaskRunner } from '@tradepilot/runtime';
import type { Logger } from 'pino';

/** worker 内部装配依赖（index.ts 构建，避免循环 import queues/registry） */
export interface WorkerRuntime {
  runner: TaskRunner;
  logger: Logger;
}

/**
 * 队列 processor（后端技术方案 04 §5.1）：BullMQ 领取 → TaskRunner 执行 LangGraph 工作流。
 * job.data = { taskId, taskType }（enqueue.ts 投递契约）；审批 resume 场景随 job.data.resume 携带。
 * 返回 RunTaskResult（skipped/missing 亦为正常完成——痕迹在 DB，job 侧不重投，attempts=1）。
 */
export function createProcessor(rt: WorkerRuntime): Processor {
  return async (job: Job) => {
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

function isResumeHint(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['nodeId'] === 'string' &&
    typeof (value as Record<string, unknown>)['approvalId'] === 'string'
  );
}
