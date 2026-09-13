import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  deliverWebhook,
  signWebhookPayload,
  WebhookDeliveryError,
  WEBHOOK_SIGNATURE_HEADER,
} from '../src/webhook-out/index.js';

/**
 * 出站 Webhook 投递适配单测（P1-X-21，06 §5.2）：
 * 签名算法、POST JSON 契约、2xx 判定、异常归一为 WebhookDeliveryError（供上层重投）。
 * 全部注入 fetch，无网络依赖。
 */
const PAYLOAD = {
  event: 'task_failed',
  type: 'task_failed',
  orgId: 'org_1',
  title: '任务失败',
  content: 'LLM 调用超时',
  refType: 'task',
  refId: 'task_1',
  occurredAt: '2026-09-13T00:00:00.000Z',
};

const FIXED_NOW = () => new Date('2026-09-13T00:00:00.000Z');

function okResponse(status = 200): Response {
  return new Response('', { status });
}

describe('出站 Webhook 投递（06 §5.2）', () => {
  it('签名头 = t={unixSeconds}, v1=HMAC-SHA256(secret, `${t}.${body}`)（独立实现比对）', () => {
    const body = JSON.stringify(PAYLOAD);
    const ts = Math.floor(FIXED_NOW().getTime() / 1000);
    const expected = createHmac('sha256', 's3cret-key').update(`${ts}.${body}`).digest('hex');

    expect(signWebhookPayload('s3cret-key', body, ts)).toBe(`t=${ts}, v1=${expected}`);
    // 任一要素变化 → 签名变化（防重放/防篡改）
    expect(signWebhookPayload('other-key', body, ts)).not.toBe(`t=${ts}, v1=${expected}`);
    expect(signWebhookPayload('s3cret-key', `${body} `, ts)).not.toBe(`t=${ts}, v1=${expected}`);
    expect(signWebhookPayload('s3cret-key', body, ts + 1)).not.toBe(`t=${ts}, v1=${expected}`);
  });

  it('2xx → 返回 { status, durationMs }，且请求为 POST + JSON + 签名头', async () => {
    const fetchImpl = vi.fn(async () => okResponse(202));

    const result = await deliverWebhook({
      url: 'https://example.com/hook',
      secret: 's3cret-key',
      payload: PAYLOAD,
      now: FIXED_NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.status).toBe(202);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://example.com/hook');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers[WEBHOOK_SIGNATURE_HEADER]).toBe(
      signWebhookPayload(
        's3cret-key',
        JSON.stringify(PAYLOAD),
        Math.floor(FIXED_NOW().getTime() / 1000),
      ),
    );
    expect(JSON.parse(String(init.body))).toEqual(PAYLOAD);
  });

  it('非 2xx → 抛 WebhookDeliveryError（透出状态码，供上层退避重投）', async () => {
    const fetchImpl = vi.fn(async () => okResponse(500));

    await expect(
      deliverWebhook({
        url: 'https://example.com/hook',
        secret: 's',
        payload: PAYLOAD,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(WebhookDeliveryError);

    await deliverWebhook({
      url: 'https://example.com/hook',
      secret: 's',
      payload: PAYLOAD,
      fetchImpl: vi.fn(async () => okResponse(404)) as unknown as typeof fetch,
    }).catch((err: unknown) => {
      expect((err as WebhookDeliveryError).status).toBe(404);
    });
  });

  it('网络/超时异常 → 抛 WebhookDeliveryError（status=0，消息含原因）', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('The operation was aborted due to timeout');
    });

    await expect(
      deliverWebhook({
        url: 'https://example.com/hook',
        secret: 's',
        payload: PAYLOAD,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Webhook 请求异常.*timeout/);
  });
});
