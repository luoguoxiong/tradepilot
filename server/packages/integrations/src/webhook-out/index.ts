/**
 * 出站 Webhook 投递适配（16 FR-11 / 后端技术方案 06 §5.2）。
 *
 * 契约：
 * - 请求：`POST {url}`，`Content-Type: application/json`，body = payload JSON；
 * - 签名：`X-TP-Signature: t={unixSeconds}, v1={HMAC-SHA256(secret, `${t}.${body}`)}`
 *   （secret 由调用方从 `webhook.secret_enc` 解密后传入，明文不进队列）；
 * - 超时：10s；非 2xx / 网络异常 → 抛 WebhookDeliveryError，交由调用方（BullMQ attempts）重试。
 *
 * 依赖方向：integrations → core。签名头名与事件载荷形状在 @tradepilot/shared
 * （`WEBHOOK_SIGNATURE_HEADER` / `WebhookPayload`）为权威定义；本包不依赖 shared，
 * 故此处以同值常量 + 结构化类型声明，保证两端结构兼容（生产端用 shared 的 zod 契约校验）。
 */
import { hmacSha256Hex } from '@tradepilot/core';

/** 签名头名（值与 @tradepilot/shared WEBHOOK_SIGNATURE_HEADER 一致） */
export const WEBHOOK_SIGNATURE_HEADER = 'x-tp-signature';

/** 单次投递超时（06 §5.2：10s） */
export const WEBHOOK_DELIVERY_TIMEOUT_MS = 10_000;

/** 出站载荷（结构化类型，兼容 @tradepilot/shared 的 WebhookPayload） */
export interface WebhookPayloadLike {
  /** 归并后的事件键（如 approval_pending / task_failed） */
  event: string;
  /** 原始事件类型（如 approval_expired） */
  type: string;
  orgId: string;
  title: string;
  content?: string;
  refType?: string;
  refId?: string;
  /** 事件发生时间（ISO 8601） */
  occurredAt: string;
}

export interface WebhookDeliveryResult {
  /** HTTP 状态码 */
  status: number;
  /** 耗时毫秒 */
  durationMs: number;
}

/** 投递失败（非 2xx 或网络/超时异常）——调用方据此重试 */
export class WebhookDeliveryError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'WebhookDeliveryError';
  }
}

/** 生成签名头值（纯函数，便于单测与消费方自助验签） */
export function signWebhookPayload(secret: string, body: string, timestamp: number): string {
  return `t=${timestamp}, v1=${hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
}

export interface DeliverWebhookOptions {
  url: string;
  /** 明文 secret（AES-256-GCM 解密后） */
  secret: string;
  payload: WebhookPayloadLike;
  timeoutMs?: number;
  now?: () => Date;
  /** 测试注入用；默认全局 fetch */
  fetchImpl?: typeof fetch;
}

/**
 * 投递一次（不重试；重试由调用方的 attempts + 指数退避承载）。
 * @throws WebhookDeliveryError 非 2xx 或网络/超时异常
 */
export async function deliverWebhook(opts: DeliverWebhookOptions): Promise<WebhookDeliveryResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const body = JSON.stringify(opts.payload);
  const timestamp = Math.floor((opts.now ?? (() => new Date()))().getTime() / 1000);
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetchImpl(opts.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [WEBHOOK_SIGNATURE_HEADER]: signWebhookPayload(opts.secret, body, timestamp),
        'user-agent': 'TradePilot-Webhook/1.0',
      },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? WEBHOOK_DELIVERY_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new WebhookDeliveryError(`Webhook 请求异常: ${message}`, 0);
  }

  const durationMs = Date.now() - startedAt;
  if (!response.ok) {
    throw new WebhookDeliveryError(`Webhook 返回非 2xx: ${response.status}`, response.status);
  }
  return { status: response.status, durationMs };
}
