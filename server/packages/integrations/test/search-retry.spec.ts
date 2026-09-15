import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpSearchProvider, SEARCH_MAX_ATTEMPTS } from '../src/search/index.js';

/**
 * 搜索外呼重试单测（04 §5.3「节点级重试」/ 06 §1「外呼超时与重试在各驱动内配置」）：
 * - web_search 带显式超时（AbortSignal.timeout），不再挂在 undici 默认连接超时上裸奔；
 * - 瞬时故障（连接超时 / 5xx / 429）按指数退避重试至成功；
 * - 确定性失败（401/403/400）立即失败，不浪费供应商配额。
 * 退避基数压到 1ms，避免用例真实等待。
 */

const OK_BODY = { organic: [{ title: 't', link: 'https://a.com/p', snippet: 's' }] };

function fakeResponse(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

/** 复刻 undici 的 fetch failed（cause = ConnectTimeoutError） */
function fetchFailed(): TypeError {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(
      new Error('Connect Timeout Error (attempted address: google.serper.dev:443)'),
      {
        name: 'ConnectTimeoutError',
        code: 'UND_ERR_CONNECT_TIMEOUT',
      },
    ),
  });
}

function provider(extra: Partial<ConstructorParameters<typeof HttpSearchProvider>[0]> = {}) {
  return new HttpSearchProvider({
    baseUrl: 'https://google.serper.dev',
    apiKey: 'k',
    backoffMs: 1,
    ...extra,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('webSearch 超时与重试（04 §5.3）', () => {
  it('连接超时（fetch failed）→ 节点内重试至成功，不抛给任务', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(fetchFailed())
      .mockRejectedValueOnce(fetchFailed())
      .mockResolvedValueOnce(fakeResponse(200, OK_BODY));
    vi.stubGlobal('fetch', fetchMock);

    const hits = await provider().webSearch('led supplier');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(hits).toEqual([{ title: 't', url: 'https://a.com/p', snippet: 's' }]);
  });

  it('5xx / 429 → 重试；总尝试次数上限为 SEARCH_MAX_ATTEMPTS', async () => {
    const onRetry = vi.fn();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(fakeResponse(503))
      .mockResolvedValueOnce(fakeResponse(429))
      .mockResolvedValue(fakeResponse(500));
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider({ onRetry }).webSearch('q')).rejects.toThrow('搜索供应商请求失败（500）');
    expect(fetchMock).toHaveBeenCalledTimes(SEARCH_MAX_ATTEMPTS);
    expect(onRetry).toHaveBeenCalledTimes(SEARCH_MAX_ATTEMPTS - 1);
  });

  it('401 确定性失败 → 只请求一次，不重试', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(fakeResponse(401, 'invalid key'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider().webSearch('q')).rejects.toThrow('401');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('每次尝试都带独立超时 signal（默认 10s / 可配 timeoutMs）', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(fakeResponse(200, OK_BODY));
    vi.stubGlobal('fetch', fetchMock);

    await provider({ timeoutMs: 1234 }).webSearch('q');

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('maxAttempts=1 → 关闭重试（首失败即抛出）', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(fetchFailed());
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider({ maxAttempts: 1 }).webSearch('q')).rejects.toThrow('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
