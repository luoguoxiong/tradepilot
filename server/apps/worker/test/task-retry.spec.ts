import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { QUEUE_NAME } from '@tradepilot/shared';
import type { RunTaskOptions, RunTaskResult, TaskRunner } from '@tradepilot/runtime';
import { createProcessor, type WorkerRuntime } from '../src/queues/processor.js';

/**
 * 任务级自动重投判定单测（04 §5.3）：
 * - 可重试失败且仍有重投机会 → processor 抛错，交由 BullMQ 按 attempts + 指数退避重投；
 * - 末次尝试 / 确定性失败 → 正常收口返回（任务保持 failed，等手动重试）；
 * - 重投 job（attemptsMade > 0）→ 带 retry 标记与 attempt 序号交给 Runner（failed→running 续跑）。
 */

function fakeJob(attemptsMade: number, attempts: number): Job {
  return {
    id: 'task_1',
    queueName: QUEUE_NAME.LEAD_HUNTING,
    data: { taskId: 'task_1', taskType: 'lead_hunting' },
    attemptsMade,
    opts: { attempts },
  } as unknown as Job;
}

function runtime(result: RunTaskResult) {
  const run = vi.fn(async (_taskId: string, opts?: RunTaskOptions) => {
    calls.push(opts);
    return result;
  });
  const calls: (RunTaskOptions | undefined)[] = [];
  const rt: WorkerRuntime = {
    runner: { run } as unknown as TaskRunner,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  };
  return { rt, run, calls };
}

describe('task job 自动重投判定（04 §5.3）', () => {
  const RETRYABLE: RunTaskResult = { status: 'failed', error: 'fetch failed', retryable: true };
  const FINAL: RunTaskResult = { status: 'failed', error: '工具入参不合法', retryable: false };

  it('可重试失败且非末次 → 抛错交由 BullMQ 退避重投', async () => {
    const { rt, calls } = runtime(RETRYABLE);
    await expect(createProcessor(rt)(fakeJob(0, 3))).rejects.toThrow('fetch failed');
    // 首次失败：retry 标记为 false（状态机仍是 scheduled→running）
    expect(calls[0]?.retry).toBeUndefined();
    expect(calls[0]?.attempt).toEqual({ made: 0, total: 3 });
  });

  it('重投 job → 带 retry=true 与 attempt 序号（Runner 走 failed→running 续跑）', async () => {
    const { rt, calls } = runtime(RETRYABLE);
    await expect(createProcessor(rt)(fakeJob(1, 3))).rejects.toThrow('fetch failed');
    expect(calls[0]?.retry).toBe(true);
    expect(calls[0]?.attempt).toEqual({ made: 1, total: 3 });
  });

  it('已到末次尝试 → 不再抛错，正常收口（任务保持 failed）', async () => {
    const { rt } = runtime(RETRYABLE);
    await expect(createProcessor(rt)(fakeJob(2, 3))).resolves.toEqual(RETRYABLE);
  });

  it('确定性失败（不可重试）→ 立即收口，不重投', async () => {
    const { rt } = runtime(FINAL);
    await expect(createProcessor(rt)(fakeJob(0, 3))).resolves.toEqual(FINAL);
  });

  it('成功/挂起/跳过 → 原样返回，不抛错', async () => {
    for (const result of [
      { status: 'completed' } as RunTaskResult,
      { status: 'waiting_approval' } as RunTaskResult,
      { status: 'skipped' } as RunTaskResult,
    ]) {
      const { rt } = runtime(result);
      await expect(createProcessor(rt)(fakeJob(0, 3))).resolves.toEqual(result);
    }
  });
});
