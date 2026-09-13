/**
 * 开放 API 密钥服务（P1-X-22 / 16 FR-11 / 后端技术方案 06 §5.1）。
 *
 * 安全要点：
 * - 生成 `tpk_live_{8hex}{base64url}`；明文仅在创建响应体返回一次，库存 sha256（`key_hash`）；
 * - 鉴权：`x-api-key` → sha256 等值命中（apikey_lookup 策略，org 未知）→ 状态/归属成员停用判定
 *   → 每 Key 固定窗口 60 req/min 限流（42901）→ `last_used_at` 记账（withOrg 写）；
 * - 停用（revoke）即时生效：每次鉴权都读库校验 `status`，不使用缓存。
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import {
  BizException,
  createId,
  ErrorCode,
  randomHex,
  randomToken,
  sha256Hex,
} from '@tradepilot/core';
import { schema, withApiKeyContext, withOrg, type Db } from '@tradepilot/db';
import { API_KEY_PREFIX, API_KEY_RATE_LIMIT_PER_MINUTE, API_KEY_STATUS } from '@tradepilot/shared';
import { DB } from '../db/db.module.js';
import { REDIS } from '../redis/redis.module.js';
import type { CreateApiKeyDto } from './open-api.dto.js';

/** 列表/创建响应（永不回显 key_hash；`key` 仅创建时存在） */
export interface ApiKeyView {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  status: string;
  createdBy: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface ApiKeyCreatedView extends ApiKeyView {
  /** 明文密钥（仅本次响应返回，之后不可再获取） */
  key: string;
}

/** 鉴权结果（供 Guard 写入 request 与开放 API 上下文） */
export interface ApiKeyAuth {
  apiKeyId: string;
  orgId: string;
  name: string;
  scopes: string[];
  /** 归属成员（为 null 表示创建者已删除，仍可继续使用） */
  createdBy: string | null;
}

const RATE_WINDOW_SECONDS = 60;

@Injectable()
export class ApiKeyService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async list(orgId: string): Promise<ApiKeyView[]> {
    return withOrg(this.db, orgId, async (tx) => {
      const rows = await tx
        .select({
          id: schema.apiKey.id,
          name: schema.apiKey.name,
          keyPrefix: schema.apiKey.keyPrefix,
          scopes: schema.apiKey.scopes,
          status: schema.apiKey.status,
          createdBy: schema.apiKey.createdBy,
          lastUsedAt: schema.apiKey.lastUsedAt,
          createdAt: schema.apiKey.createdAt,
        })
        .from(schema.apiKey)
        .where(eq(schema.apiKey.orgId, orgId))
        .orderBy(desc(schema.apiKey.createdAt));
      return rows.map(toApiKeyView);
    });
  }

  async create(orgId: string, userId: string, dto: CreateApiKeyDto): Promise<ApiKeyCreatedView> {
    const keyPrefix = `${API_KEY_PREFIX}${randomHex(4)}`;
    const plainKey = `${keyPrefix}${randomToken(24)}`;
    const id = createId('key');
    const row = await withOrg(this.db, orgId, async (tx) => {
      const [inserted] = await tx
        .insert(schema.apiKey)
        .values({
          id,
          orgId,
          name: dto.name,
          keyPrefix,
          keyHash: sha256Hex(plainKey),
          scopes: dto.scopes,
          status: API_KEY_STATUS.ACTIVE,
          createdBy: userId,
        })
        .returning();
      if (!inserted) {
        throw new BizException(ErrorCode.INTERNAL, 'API Key 创建失败');
      }
      return inserted;
    });
    return { ...toApiKeyView(row), key: plainKey };
  }

  /** 撤销（幂等：已撤销再撤销返回 404——列表已无 active 语义优势，仍按资源不存在处理） */
  async revoke(orgId: string, id: string): Promise<{ id: string; status: string }> {
    return withOrg(this.db, orgId, async (tx) => {
      const [row] = await tx
        .update(schema.apiKey)
        .set({ status: API_KEY_STATUS.REVOKED, updatedAt: new Date() })
        .where(eq(schema.apiKey.id, id))
        .returning({ id: schema.apiKey.id, status: schema.apiKey.status });
      if (!row) {
        throw new BizException(ErrorCode.NOT_FOUND, 'API Key 不存在');
      }
      return row;
    });
  }

  /**
   * 入站鉴权（06 §5.1）：明文 → sha256 命中 → 有效性 → 限流 → last_used_at 记账。
   * @throws BizException UNAUTHORIZED（无效/已撤销）/ RATE_LIMITED（超限）
   */
  async authenticate(rawKey: string): Promise<ApiKeyAuth> {
    const keyHash = sha256Hex(rawKey);
    // org 未知 → apikey_lookup 上下文（manual 0013），等值命中断言由 key_hash 唯一索引承担
    const row = await withApiKeyContext(this.db, async (tx) => {
      const [found] = await tx
        .select({
          id: schema.apiKey.id,
          orgId: schema.apiKey.orgId,
          name: schema.apiKey.name,
          scopes: schema.apiKey.scopes,
          status: schema.apiKey.status,
          createdBy: schema.apiKey.createdBy,
        })
        .from(schema.apiKey)
        .where(eq(schema.apiKey.keyHash, keyHash))
        .limit(1);
      return found;
    });

    // 防密钥枚举：不存在 / 已撤销 / 归属成员停用 → 同一错误码与文案
    if (!row || row.status !== API_KEY_STATUS.ACTIVE) {
      throw new BizException(ErrorCode.UNAUTHORIZED, 'API Key 无效或已撤销');
    }
    if (row.createdBy) {
      const owner = await withOrg(this.db, row.orgId, async (tx) => {
        const [user] = await tx
          .select({ status: schema.userAccount.status })
          .from(schema.userAccount)
          .where(eq(schema.userAccount.id, row.createdBy as string))
          .limit(1);
        return user;
      });
      if (owner && owner.status !== 'active') {
        throw new BizException(ErrorCode.UNAUTHORIZED, 'API Key 无效或已撤销');
      }
    }

    await this.assertRateLimit(row.id);
    await this.touchLastUsed(row.orgId, row.id);

    return {
      apiKeyId: row.id,
      orgId: row.orgId,
      name: row.name,
      scopes: row.scopes,
      createdBy: row.createdBy,
    };
  }

  /** 固定窗口限流（与 RateLimitMiddleware 同范式；Redis 故障 fail-open） */
  private async assertRateLimit(apiKeyId: string): Promise<void> {
    const limit = resolveApiKeyLimit();
    if (limit <= 0) {
      return;
    }
    const windowIndex = Math.floor(Date.now() / (RATE_WINDOW_SECONDS * 1000));
    const key = `rl:apikey:${apiKeyId}:${windowIndex}`;
    try {
      const used = await this.redis.incr(key);
      if (used === 1) {
        await this.redis.expire(key, RATE_WINDOW_SECONDS + 5);
      }
      if (used > limit) {
        throw new BizException(ErrorCode.RATE_LIMITED, `API Key 超出限流阈值（${limit} req/min）`);
      }
    } catch (err: unknown) {
      if (err instanceof BizException) {
        throw err;
      }
      // fail-open：限流不可用不应阻断开放 API
    }
  }

  /** last_used_at 记账（失败不阻断请求） */
  private async touchLastUsed(orgId: string, apiKeyId: string): Promise<void> {
    try {
      await withOrg(this.db, orgId, async (tx) => {
        await tx
          .update(schema.apiKey)
          .set({ lastUsedAt: new Date() })
          .where(eq(schema.apiKey.id, apiKeyId));
      });
    } catch {
      // 记账失败不影响鉴权结果
    }
  }
}

function resolveApiKeyLimit(): number {
  const raw = Number(process.env['API_KEY_RATE_LIMIT_PER_MINUTE'] ?? '');
  return Number.isFinite(raw) && raw >= 0 ? raw : API_KEY_RATE_LIMIT_PER_MINUTE;
}

function toApiKeyView(row: {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  status: string;
  createdBy: string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}): ApiKeyView {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    scopes: row.scopes,
    status: row.status,
    createdBy: row.createdBy,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
