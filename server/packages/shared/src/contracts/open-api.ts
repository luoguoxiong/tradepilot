/**
 * 开放 API 与出站 Webhook 契约（16 FR-11 / 后端技术方案 06 §5）。
 *
 * - API Key：`tpk_{keyPrefix}{random}`，明文仅创建时返回一次，库存 sha256（`api_key.key_hash`）；
 *   入站鉴权 `x-api-key` → scopes 校验 → 每 Key 60 req/min 限流（42901）→ `last_used_at` 记账。
 * - Webhook：org 订阅 `{ url, events[], secret }`，`secret` 密文存储（`webhook.secret_enc`）；
 *   签名头 `X-TP-Signature: t={ts}, v1={HMAC-SHA256(secret, t + '.' + body)}`。
 */
import { z } from 'zod';

/** API Key scope 注册表（`{资源}:{动作}`；新增资源在此扩展，不改 DDL） */
export const API_SCOPE = {
  CUSTOMERS_READ: 'customers:read',
  CUSTOMERS_WRITE: 'customers:write',
  TASKS_READ: 'tasks:read',
  TASKS_WRITE: 'tasks:write',
  QUOTES_READ: 'quotes:read',
  QUOTES_WRITE: 'quotes:write',
  ORDERS_READ: 'orders:read',
  ORDERS_WRITE: 'orders:write',
  ANALYTICS_READ: 'analytics:read',
} as const;

export type ApiScope = (typeof API_SCOPE)[keyof typeof API_SCOPE];

/** 全部 scope（DTO 白名单按此校验，避免脏数据） */
export const API_SCOPE_LIST: readonly string[] = Object.values(API_SCOPE);

/** API Key 明文前缀（列表识别用；ER 01 §2.9 `key_prefix`） */
export const API_KEY_PREFIX = 'tpk_live_';

/** 每 Key 每分钟请求上限（06 §5.1；env `API_KEY_RATE_LIMIT_PER_MINUTE` 可调） */
export const API_KEY_RATE_LIMIT_PER_MINUTE = 60;

/** API Key 状态（ER 01 §2.9：active / revoked） */
export const API_KEY_STATUS = { ACTIVE: 'active', REVOKED: 'revoked' } as const;

/**
 * Webhook 事件注册表（可扩展）：
 * - 与 `q.notify` 事件键同域的三项（ER 01 §2.10 / 16 FR-09）：approval_pending / risk_alert / task_failed；
 * - 06 §5.2 业务事件（点号命名）：task.completed / approval.decided / message.received / customer.created。
 */
export const WEBHOOK_EVENT = {
  APPROVAL_PENDING: 'approval_pending',
  RISK_ALERT: 'risk_alert',
  TASK_FAILED: 'task_failed',
  TASK_COMPLETED: 'task.completed',
  APPROVAL_DECIDED: 'approval.decided',
  MESSAGE_RECEIVED: 'message.received',
  CUSTOMER_CREATED: 'customer.created',
} as const;

export type WebhookEvent = (typeof WEBHOOK_EVENT)[keyof typeof WEBHOOK_EVENT];

/** 全部可订阅事件（DTO 白名单） */
export const WEBHOOK_EVENT_LIST: readonly string[] = Object.values(WEBHOOK_EVENT);

/** Webhook 状态（ER 01 §2.10：active / disabled） */
export const WEBHOOK_STATUS = { ACTIVE: 'active', DISABLED: 'disabled' } as const;

/** 投递超时（06 §5.2：10s） */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/** 投递重试次数（06 §5.2：5 次指数退避 → 死信标记） */
export const WEBHOOK_MAX_ATTEMPTS = 5;

/** 投递抖动基数（BullMQ exponential backoff，1m 起） */
export const WEBHOOK_BACKOFF_MS = 60_000;

/** 签名头名（06 §5.2） */
export const WEBHOOK_SIGNATURE_HEADER = 'x-tp-signature';

/**
 * 事件订阅匹配（06 §5.2 + ER 01 §2.10 兼容）：
 * 订阅项命中「原始事件类型」或「归并后的通知事件键」即投递。
 */
export function webhookMatchesEvent(
  events: readonly string[],
  type: string,
  eventKey: string,
): boolean {
  return events.includes(type) || events.includes(eventKey);
}

/** 出站 Webhook 载荷（POST JSON body，06 §5.2） */
export const webhookPayloadSchema = z.object({
  event: z.string().min(1),
  /** 原始事件类型（与订阅项可不同，便于消费方区分 approval_expired 等细分） */
  type: z.string().min(1),
  orgId: z.string().min(1),
  title: z.string().min(1),
  content: z.string().optional(),
  refType: z.string().optional(),
  refId: z.string().optional(),
  /** 事件发生时间（ISO 8601） */
  occurredAt: z.string().min(1),
});

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;

/** q:webhook job 载荷（消费端安全解析；投递重试由 BullMQ attempts 承载） */
export const webhookJobSchema = z.object({
  webhookId: z.string().min(1),
  orgId: z.string().min(1),
  url: z.string().min(1),
  payload: webhookPayloadSchema,
});

export type WebhookJob = z.infer<typeof webhookJobSchema>;
