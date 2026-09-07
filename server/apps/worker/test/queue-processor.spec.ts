import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import pino from 'pino';
import type { TaskRunner } from '@tradepilot/runtime';
import { QUEUE_NAME } from '@tradepilot/shared';
import { createProcessor } from '../src/queues/processor.js';

/**
 * M3-12 processor 按队列分流单测（后端技术方案 04 §1）：
 * - task_type 队列（job.id = ai_task.id）→ TaskRunner 执行，resume 透传；
 * - 系统队列（q:notify / q:email_sync，不落 ai_task）→ 系统处理器消费留痕，
 *   绝不触发 runner.run——否则 job.id 非任务 id，runner 误查落空（missing/skipped）静默吞载荷。
 * 无外部依赖（DB/Redis/BullMQ 均 mock），纯逻辑验证。
 */

const silent = pino({ level: 'silent' });

/** 最小 Job 形状（processor 只消费 id/queueName/data 三字段） */
function fakeJob(queueName: string, id = 'job-1', data: Record<string, unknown> = {}): Job {
  return { id, queueName, data } as unknown as Job;
}

/** 装配带 mock run 的 processor */
function makeProcessor(run: ReturnType<typeof vi.fn>, logger: ReturnType<typeof pino> = silent) {
  const runner = { run } as unknown as TaskRunner;
  return { processor: createProcessor({ runner, logger }), runner };
}

describe('queue processor 分流（M3-12）', () => {
  it('task_type 队列 → TaskRunner 执行（job.id = taskId）', async () => {
    const { processor, runner } = makeProcessor(
      vi.fn(async () => ({ status: 'completed', outputs: [] })),
    );

    const result = await processor(
      fakeJob('q.lead_hunting', 'task_1', { taskType: 'lead_hunting' }),
    );

    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(runner.run).toHaveBeenCalledWith('task_1', undefined);
    expect(result).toEqual({ status: 'completed', outputs: [] });
  });

  it('resume job 随 job.data.resume 透传为 { resume }', async () => {
    const { processor, runner } = makeProcessor(
      vi.fn(async () => ({ status: 'waiting_approval' })),
    );
    const hint = { nodeId: 'node_email_send', approvalId: 'appr_1' };

    await processor(fakeJob('q.follow_up', 'task_2', { taskType: 'follow_up', resume: hint }));

    expect(runner.run).toHaveBeenCalledWith('task_2', { resume: hint });
  });

  it('job.data.resume 非合法形状 → 按无 resume 执行', async () => {
    const { processor, runner } = makeProcessor(vi.fn(async () => ({ status: 'failed' })));

    await processor(fakeJob('q.email_reply', 'task_3', { resume: { foo: 'bar' } }));

    expect(runner.run).toHaveBeenCalledWith('task_3', undefined);
  });

  it('q:notify / q:email_sync 系统队列 → 消费留痕，不触发 TaskRunner', async () => {
    const run = vi.fn();
    const logger = pino({ level: 'silent' });
    const infoSpy = vi.spyOn(logger, 'info');
    const warnSpy = vi.spyOn(logger, 'warn');
    const proc = createProcessor({ runner: { run } as unknown as TaskRunner, logger });

    const notifyResult = await proc(
      fakeJob(QUEUE_NAME.NOTIFY, 'notify-1', { type: 'approval_expired', approvalId: 'appr_1' }),
    );
    const syncResult = await proc(fakeJob(QUEUE_NAME.EMAIL_SYNC, 'sync-1'));

    expect(notifyResult).toBeUndefined();
    expect(syncResult).toBeUndefined();
    // 系统队列 job 绝不触发 TaskRunner（防误跑静默吞载荷）
    expect(run).not.toHaveBeenCalled();
    // 显式留痕（q:notify = info；q:email_sync = warn），非静默
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
