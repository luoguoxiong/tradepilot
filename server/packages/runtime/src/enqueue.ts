/**
 * 入队路径封装（后端技术方案 04 §1/§2）：
 * jobId=taskId（同 id 活跃 job 唯一，天然防重复入队）；removeOnComplete/removeOnFail 开启。
 * 四条入队路径（API 触发 / Scheduler 到期 / delayed job / 手动重试）统一经此封装。
 */
import { Queue } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
import {
  ALL_QUEUES,
  QUEUE_NAME,
  TASK_TYPE_QUEUE,
  type QueueName,
  type TaskType,
} from '@tradepilot/shared';
import type { ResumeHint } from './runner.js';

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
    await queue.add(
      taskType,
      { taskId, taskType },
      {
        jobId: taskId,
        ...(opts?.delayMs !== undefined && opts.delayMs > 0 ? { delay: opts.delayMs } : {}),
      },
    );
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

  /**
   * email_sync 队列（M4 #4 收信链路）：jobId=`mbxsync.{mailboxId}` 防重复入队
   * （同 mailbox 活跃 job 唯一——调度器 5min 周期与长同步天然互斥，不堆积）。
   *
   * 注意：BullMQ Queue.add 对同 jobId 若 job 仍存在则幂等 no-op（不更新、不重投）。
   * removeOnComplete/fail 留存期内调度器每轮同 id add 全被吞 → 同步停摆（#5/#6 联调实证）。
   * 因此入队前先移除「终态历史 job」，仅保留 waiting/active/delayed 以维持互斥节流。
   */
  async enqueueEmailSync(mailboxId: string): Promise<void> {
    const queue = this.queues.get(QUEUE_NAME.EMAIL_SYNC);
    if (!queue) {
      return;
    }
    const jobId = `mbxsync.${mailboxId}`;
    await this.removeTerminalJob(queue, jobId, '邮箱同步');
    await queue.add(
      'email_sync',
      { mailboxId },
      // jobId 禁含 ':'（BullMQ 5 校验），用 '.' 分隔
      { jobId },
    );
  }

  /**
   * 知识索引投递（M4 #7 入库流水线，07 §2）：q:knowledge_index，jobId=`kidx.{docId}`
   * 防重复入队（同文档重试/并发上传互斥）。job.data={ docId }，processor 按 docId 分流到
   * KnowledgeIndexProcessor（区别于走 TaskRunner 的 ai_task job——后者 job.data 带 taskType）。
   * jobId 禁含 ':'（BullMQ 5 校验，与队列名 q.xxx 同规则），用 '.' 分隔。
   */
  async enqueueKnowledgeIndex(docId: string): Promise<void> {
    const queue = this.queues.get(QUEUE_NAME.KNOWLEDGE_INDEX);
    if (!queue) {
      return;
    }
    const jobId = `kidx.${docId}`;
    await this.removeTerminalJob(queue, jobId, '知识索引');
    await queue.add('knowledge_index', { docId }, { jobId });
  }

  /**
   * 移除同 id 的终态（completed/failed）历史 job。
   *
   * BullMQ 5 Queue.add 对仍存在的同 jobId 幂等 no-op：新数据不生效、不重新入队，
   * 而 removeOnComplete/fail 会留存终态 job（age1h/count1000 / 24h），导致手动重试
   * （04 §5.3）与周期性调度（5min 邮箱同步）被静默吞掉。此处在入队前清掉终态 job，
   * 保证重投必达；waiting/active/delayed 保留 → add no-op，维持「同 id 活跃 job 唯一」互斥。
   */
  private async removeTerminalJob(queue: Queue, jobId: string, label: string): Promise<void> {
    const existing = await queue.getJob(jobId);
    if (!existing) {
      return;
    }
    let state: string;
    try {
      state = await existing.getState();
    } catch (err) {
      this.logger?.warn(`读取 job 状态失败: ${jobId}`, err);
      return;
    }
    if (state !== 'completed' && state !== 'failed') {
      return;
    }
    try {
      await existing.remove();
    } catch (err) {
      this.logger?.warn(`移除${label}历史 job 失败: ${jobId}`, err);
    }
  }

  /**
   * 审批 resume 投递（M4 12 接口回调）：approve/reject（编辑留痕已在 approval_request 落库）后
   * 按原 jobId=taskId 重投 task 队列，job.data.resume={ nodeId, approvalId } 供 Runner 恢复图执行。
   */
  async enqueueResume(taskId: string, taskType: TaskType, resume: ResumeHint): Promise<void> {
    const queueName = TASK_TYPE_QUEUE[taskType];
    const queue = this.queues.get(queueName);
    if (!queue) {
      return;
    }
    await queue.add(taskType, { taskId, taskType, resume }, { jobId: taskId });
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
  }
}
