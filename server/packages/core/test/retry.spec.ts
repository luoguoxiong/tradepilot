import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../src/error-codes.js';
import { BizException } from '../src/errors.js';
import { computeBackoffMs, isRetryableError, isRetryableStatus, withRetry } from '../src/retry.js';

/**
 * 重试原语单测（04 §5.3「节点级重试」/ 06 §1「外呼超时与重试在各驱动内配置」）：
 * - 可重试判定：网络/超时/429/5xx 与「依赖不可用」可重试；业务性失败（4xx/权限/状态冲突/额度）不可重试；
 * - 退避：指数增长 + 上限；
 * - 执行器：可重试失败重试至成功、耗尽后抛出末次错误、不可重试立即抛出、signal 中止不再重试。
 */

/** 复刻 undici 的 `fetch failed`（cause 挂 ConnectTimeoutError，日志中实测形态） */
function connectTimeoutError(): unknown {
  const cause = Object.assign(new Error('Connect Timeout Error (attempted address: x:443)'), {
    name: 'ConnectTimeoutError',
    code: 'UND_ERR_CONNECT_TIMEOUT',
  });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

describe('isRetryableStatus', () => {
  it('408/425/429/5xx 可重试', () => {
    for (const s of [408, 425, 429, 500, 502, 503, 504]) {
      expect(isRetryableStatus(s)).toBe(true);
    }
  });

  it('其余 4xx 为确定性失败，不可重试', () => {
    for (const s of [400, 401, 403, 404, 409, 422]) {
      expect(isRetryableStatus(s)).toBe(false);
    }
  });
});

describe('isRetryableError', () => {
  it('fetch failed（cause=UND_ERR_CONNECT_TIMEOUT）→ 可重试', () => {
    expect(isRetryableError(connectTimeoutError())).toBe(true);
  });

  it('AbortError（AbortSignal.timeout 超时）→ 可重试', () => {
    const err = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'AbortError',
    });
    expect(isRetryableError(err)).toBe(true);
  });

  it('网络栈错误码 → 可重试', () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE']) {
      expect(isRetryableError(Object.assign(new Error('boom'), { code }))).toBe(true);
    }
  });

  it('HTTP 5xx / 429 → 可重试；401 → 不可重试', () => {
    expect(isRetryableError(Object.assign(new Error('server error'), { status: 503 }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error('too many'), { status: 429 }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error('unauthorized'), { status: 401 }))).toBe(false);
  });

  it('BizException：依赖不可用可重试，业务性失败不可重试', () => {
    expect(isRetryableError(new BizException(ErrorCode.DEPENDENCY_UNAVAILABLE))).toBe(true);
    expect(isRetryableError(new BizException(ErrorCode.CONFLICT))).toBe(false);
    expect(isRetryableError(new BizException(ErrorCode.FORBIDDEN))).toBe(false);
    // 员工日额度耗尽 = 转 paused 等次日重置（03 §3.7），重试无益
    expect(isRetryableError(new BizException(ErrorCode.RATE_LIMITED))).toBe(false);
  });

  it('普通业务错误 → 不可重试', () => {
    expect(isRetryableError(new Error('工具入参不合法: xxx'))).toBe(false);
    expect(isRetryableError('参数错误')).toBe(false);
    expect(isRetryableError(null)).toBe(false);
  });
});

describe('computeBackoffMs', () => {
  it('指数增长并钳到上限（抖动关闭）', () => {
    const opts = { initialDelayMs: 100, maxDelayMs: 500, factor: 2, jitterRatio: 0 };
    expect(computeBackoffMs(1, opts)).toBe(100);
    expect(computeBackoffMs(2, opts)).toBe(200);
    expect(computeBackoffMs(3, opts)).toBe(400);
    expect(computeBackoffMs(4, opts)).toBe(500);
  });

  it('抖动范围落在 ±jitterRatio 内', () => {
    for (let i = 0; i < 50; i++) {
      const ms = computeBackoffMs(2, { initialDelayMs: 1000, jitterRatio: 0.2 });
      expect(ms).toBeGreaterThanOrEqual(1600);
      expect(ms).toBeLessThanOrEqual(2400);
    }
  });
});

describe('withRetry', () => {
  it('可重试失败 → 退避后重试至成功', async () => {
    const sleep = vi.fn(async () => undefined);
    const onRetry = vi.fn();
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) {
          throw Object.assign(new Error('搜索供应商请求失败（503）'), { status: 503 });
        }
        return 'ok';
      },
      { attempts: 3, initialDelayMs: 10, jitterRatio: 0, sleep, onRetry },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]?.[0]?.attempt).toBe(1);
    expect(onRetry.mock.calls[1]?.[0]?.attempt).toBe(2);
  });

  it('重试耗尽 → 抛出最后一次错误（保留原始错误对象）', async () => {
    const last = Object.assign(new Error('搜索供应商请求失败（503）'), { status: 503 });
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw last;
        },
        { attempts: 3, initialDelayMs: 1, jitterRatio: 0, sleep: async () => undefined },
      ),
    ).rejects.toBe(last);
    expect(calls).toBe(3);
  });

  it('不可重试错误 → 立即抛出，不重试不等待', async () => {
    const sleep = vi.fn(async () => undefined);
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw Object.assign(new Error('搜索供应商请求失败（401）'), { status: 401 });
        },
        { attempts: 3, sleep },
      ),
    ).rejects.toThrow('401');
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('signal 已中止 → 不再重试', async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    await expect(
      withRetry(
        async () => {
          calls++;
          throw connectTimeoutError();
        },
        { attempts: 3, signal: controller.signal, sleep: async () => undefined },
      ),
    ).rejects.toThrow('fetch failed');
    expect(calls).toBe(1);
  });
});
