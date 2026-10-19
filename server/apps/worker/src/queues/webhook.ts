/**
 * q:webhook 消费者——出站 Webhook 投递（P1-X-21，后端技术方案 06 §5.2 / 16 FR-11）：
 * 由 q:notify 分发后按订阅逐条派生的独立队列，job 级 attempts=5 + 指数退避（1m 起）。
 *
 * 安全与容错：
 * - job 载荷不含 secret（明文不进 Redis）；每次投递按 `webhookId` 回库取 `secret_enc` 解密；
 * - 订阅已删除/已停用 → 记日志后按成功结束（不重投无意义）；
 * - 投递失败抛错 → 交由 BullMQ 按 attempts 重投；末次失败打 `deadLetter` 标记（06 §5.2 死信标记）。
 */
import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { decryptSecret } from '@tradepilot/core';
import { schema, withOrg, type Db } from '@tradepilot/db';
import { deliverWebhook, type DeliverWebhookOptions } from '@tradepilot/integrations';
import { WEBHOOK_STATUS, type WebhookJob } from '@tradepilot/shared';

export interface WebhookDeliveryDeps {
  db: Db;
  logger: Logger;
  /** 凭据解密主密钥（AES-256-GCM，08 §2） */
  encryptionKey: string;
  /** 测试注入用；默认 integrations.deliverWebhook */
  deliver?: typeof deliverWebhook;
}

export interface WebhookDeliveryOutcome {
  webhookId: string;
  /** 订阅已不存在/已停用 → 跳过（非失败） */
  skipped?: boolean;
  /** HTTP 状态码（失败抛错时不会返回） */
  status: number;
  durationMs: number;
}

/** 末次尝试标记（死信留痕口径：attemptsMade 从 0 起算） */
export interface WebhookAttemptInfo {
  attemptsMade: number;
  attempts: number;
}

export class WebhookDeliveryProcessor {
  constructor(private readonly deps: WebhookDeliveryDeps) {}

  async process(job: WebhookJob, attempt: WebhookAttemptInfo): Promise<WebhookDeliveryOutcome> {
    const { db, logger, encryptionKey } = this.deps;
    const deliver = this.deps.deliver ?? deliverWebhook;

    const subscription = await withOrg(db, job.orgId, async (tx) => {
      const [row] = await tx
        .select({
          id: schema.webhook.id,
          url: schema.webhook.url,
          secretEnc: schema.webhook.secretEnc,
          status: schema.webhook.status,
        })
        .from(schema.webhook)
        .where(and(eq(schema.webhook.id, job.webhookId), eq(schema.webhook.orgId, job.orgId)))
        .limit(1);
      return row;
    });

    if (!subscription || subscription.status !== WEBHOOK_STATUS.ACTIVE) {
      logger.info(
        {
          webhookId: job.webhookId,
          orgId: job.orgId,
          event: job.payload.event,
          exists: Boolean(subscription),
        },
        'Webhook 订阅缺失或已停用，跳过投递',
      );
      return { webhookId: job.webhookId, skipped: true, status: 0, durationMs: 0 };
    }

    const secret = decryptSecret(subscription.secretEnc, encryptionKey);
    try {
      const result = await deliver({
        url: subscription.url,
        secret,
        payload: job.payload,
      } satisfies DeliverWebhookOptions);
      logger.info(
        {
          webhookId: job.webhookId,
          orgId: job.orgId,
          event: job.payload.event,
          status: result.status,
          durationMs: result.durationMs,
          attempt: attempt.attemptsMade + 1,
        },
        'Webhook 投递成功',
      );
      return { webhookId: job.webhookId, status: result.status, durationMs: result.durationMs };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const willRetry = attempt.attemptsMade + 1 < attempt.attempts;
      logger.error(
        {
          webhookId: job.webhookId,
          orgId: job.orgId,
          event: job.payload.event,
          attempt: attempt.attemptsMade + 1,
          attempts: attempt.attempts,
          deadLetter: !willRetry,
          err: message,
        },
        willRetry ? 'Webhook 投递失败，等待退避重投' : 'Webhook 投递失败且已达最大重试次数（死信）',
      );
      // 抛出交由 BullMQ 重投（attempts 用尽后 job 落 failed，removeOnFail 保留 24h 供排查）
      throw err;
    }
  }
}
