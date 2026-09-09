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
    // M5-A2 后 q:notify 由 NotifyProcessor 实装消费（mock 分发结果 → info 留痕）；
    // q:email_sync 未装配（emailSync 缺省）→ warn 降级留痕
    const notify = {
      process: vi.fn(async () => ({ orgId: 'org_1', event: 'approval_pending', site: true, email: 'skipped' })),
    };
    const proc = createProcessor({
      runner: { run } as unknown as TaskRunner,
      logger,
      notify: notify as never,
    });

    const notifyResult = await proc(
      fakeJob(QUEUE_NAME.NOTIFY, 'notify-1', {
        type: 'approval_expired',
        orgId: 'org_1',
        title: '审批超时提醒',
        approvalId: 'appr_1',
      }),
    );
    const syncResult = await proc(fakeJob(QUEUE_NAME.EMAIL_SYNC, 'sync-1'));

    expect(notifyResult).toBeUndefined();
    expect(syncResult).toBeUndefined();
    // 系统队列 job 绝不触发 TaskRunner（防误跑静默吞载荷）
    expect(run).not.toHaveBeenCalled();
    // q:notify：NotifyProcessor 消费（载荷解析透传，非契约字段被 zod 剥离）+ info 留痕
    expect(notify.process).toHaveBeenCalledTimes(1);
    expect(notify.process).toHaveBeenCalledWith({
      type: 'approval_expired',
      orgId: 'org_1',
      title: '审批超时提醒',
    });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    // q:email_sync：未装配 → warn 降级留痕
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('q:notify 载荷畸形（缺 orgId/title）→ warn 留痕跳过，不抛错重投', async () => {
    const run = vi.fn();
    const logger = pino({ level: 'silent' });
    const warnSpy = vi.spyOn(logger, 'warn');
    const notify = { process: vi.fn() };
    const proc = createProcessor({
      runner: { run } as unknown as TaskRunner,
      logger,
      notify: notify as never,
    });

    const result = await proc(
      fakeJob(QUEUE_NAME.NOTIFY, 'notify-2', { type: 'approval_expired', approvalId: 'appr_1' }),
    );

    expect(result).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(notify.process).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
