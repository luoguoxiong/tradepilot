/**
 * 出站 Webhook 订阅服务（P1-X-21 / 16 FR-11 / 后端技术方案 06 §5.2）。
 *
 * - 订阅：`{ url, events[], secret }`；secret 以 AES-256-GCM 信封加密入库（`secret_enc`），
 *   接口永不回显（含列表）；
 * - 投递：事件由 `q:notify` 分发后派生 `q:webhook` job（q:notify → POST JSON），
 *   签名头 `X-TP-Signature`，超时 10s，attempts=5 + 指数退避（1m 起）；
 * - 停止投递：DELETE（物理删除订阅，ER 01 §2.10 无软删列）。
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { BizException, createId, encryptSecret, ErrorCode } from '@tradepilot/core';
import { schema, withOrg, type Db } from '@tradepilot/db';
import { EnvService } from '../config/env.service.js';
import { DB } from '../db/db.module.js';
import type { CreateWebhookDto } from './open-api.dto.js';

/** 订阅视图（不含 secret / secret_enc） */
export interface WebhookView {
  id: string;
  url: string;
  events: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class WebhookService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(EnvService) private readonly env: EnvService,
  ) {}

  async list(orgId: string): Promise<WebhookView[]> {
    return withOrg(this.db, orgId, async (tx) => {
      const rows = await tx
        .select({
          id: schema.webhook.id,
          url: schema.webhook.url,
          events: schema.webhook.events,
          status: schema.webhook.status,
          createdAt: schema.webhook.createdAt,
          updatedAt: schema.webhook.updatedAt,
        })
        .from(schema.webhook)
        .where(eq(schema.webhook.orgId, orgId))
        .orderBy(desc(schema.webhook.createdAt));
      return rows.map(toWebhookView);
    });
  }

  async create(orgId: string, dto: CreateWebhookDto): Promise<WebhookView> {
    const id = createId('hook');
    const row = await withOrg(this.db, orgId, async (tx) => {
      const [inserted] = await tx
        .insert(schema.webhook)
        .values({
          id,
          orgId,
          url: dto.url,
          events: dto.events,
          secretEnc: encryptSecret(dto.secret, this.env.env.ENCRYPTION_KEY),
          status: 'active',
        })
        .returning();
      if (!inserted) {
        throw new BizException(ErrorCode.INTERNAL, 'Webhook 创建失败');
      }
      return inserted;
    });
    return toWebhookView(row);
  }

  async remove(orgId: string, id: string): Promise<{ id: string }> {
    return withOrg(this.db, orgId, async (tx) => {
      const [row] = await tx
        .delete(schema.webhook)
        .where(eq(schema.webhook.id, id))
        .returning({ id: schema.webhook.id });
      if (!row) {
        throw new BizException(ErrorCode.NOT_FOUND, 'Webhook 不存在');
      }
      return row;
    });
  }
}

function toWebhookView(row: {
  id: string;
  url: string;
  events: string[];
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): WebhookView {
  return {
    id: row.id,
    url: row.url,
    events: row.events,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
