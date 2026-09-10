import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { BizException, createId, encryptSecret, ErrorCode } from '@tradepilot/core';
import { schema, withOrg, type Db, type Tx } from '@tradepilot/db';
import { KNOWLEDGE_EMBEDDING_DIMENSIONS } from '@tradepilot/integrations';
import { resolveActiveModel, type ActiveModelConfig } from '@tradepilot/runtime';
import { DB } from '../db/db.module.js';
import { EnvService } from '../config/env.service.js';
import type { AiModelSelectionDto, CreateAiModelDto, UpdateAiModelDto } from './ai-models.dto.js';

/** embedding 支持的 provider（integrations 仅实现 mock / openai 兼容协议） */
const EMBEDDING_PROVIDERS: readonly string[] = ['mock', 'openai'];

/** search 支持的 provider（integrations 仅实现 mock / http 即 Serper 兼容搜索 API，06 §3） */
const SEARCH_PROVIDERS: readonly string[] = ['mock', 'http'];

/**
 * AI 模型配置服务（接口 16 FR-10 扩展）：
 * - 模型台账：按 org 维护 type=llm / type=embedding / type=search 三组配置（CRUD）；
 * - 全局选用：每个 type 至多一个 isSelected 配置，作为整个服务该类型的默认值；
 * - 凭据安全：apiKey AES-256-GCM 信封加密落库（08 §2），响应仅回显 hasApiKey；
 * - 首建自动选中：某 type 下第一个配置创建即置为 selected；删除选中的配置自动回退到该 type 最早创建的配置；
 * - 生效链路：LlmGateway / Embedding Provider / Search Provider 经 runtime resolveActiveModel
 *   读取选用配置（全服务统一口径）。
 */

export interface AiModelView {
  id: string;
  type: 'llm' | 'embedding' | 'search';
  name: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  dimensions: number | null;
  temperature: string;
  maxTokens: number | null;
  /** 是否已配置 apiKey（密文不回显） */
  hasApiKey: boolean;
  /** 是否为该 type 下当前生效模型 */
  isSelected: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AiModelsView {
  models: AiModelView[];
  selection: { llm: string | null; embedding: string | null; search: string | null };
}

/** 运行时消费视图（已解密）；实现见 runtime model-config.resolveActiveModel */
export type ActiveAiModel = ActiveModelConfig;

@Injectable()
export class AiModelsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(EnvService) private readonly env: EnvService,
  ) {}

  async list(orgId: string): Promise<AiModelsView> {
    return withOrg(this.db, orgId, (tx) => this.toView(tx, orgId));
  }

  async create(orgId: string, userId: string, dto: CreateAiModelDto): Promise<AiModelView> {
    // 按 type 收窄：字段必填性与 provider 白名单随类型而异（与 embedding 维度校验同口径）
    if (dto.type === 'search') {
      assertSearchUsable(dto.provider, dto.baseUrl ?? null, Boolean(dto.apiKey));
    } else {
      if (!dto.model) {
        throw new BizException(ErrorCode.BIZ_VALIDATION, '模型标识必填');
      }
      if (dto.type === 'embedding') {
        assertEmbeddingUsable(dto.provider, dto.dimensions ?? null);
      }
    }
    return withOrg(this.db, orgId, async (tx) => {
      const [dup] = await tx
        .select({ id: schema.aiModel.id })
        .from(schema.aiModel)
        .where(
          and(
            eq(schema.aiModel.orgId, orgId),
            eq(schema.aiModel.type, dto.type),
            eq(schema.aiModel.name, dto.name),
          ),
        )
        .limit(1);
      if (dup) {
        throw new BizException(ErrorCode.CONFLICT, '同名模型已存在');
      }

      // 该 type 下首个模型创建即选中（全局默认）
      const [existing] = await tx
        .select({ id: schema.aiModel.id })
        .from(schema.aiModel)
        .where(and(eq(schema.aiModel.orgId, orgId), eq(schema.aiModel.type, dto.type)))
        .limit(1);

      const [row] = await tx
        .insert(schema.aiModel)
        .values({
          id: createId('aim'),
          orgId,
          type: dto.type,
          name: dto.name,
          provider: dto.provider,
          // search 无「模型标识」，以 provider 名占位（model 列 NOT NULL，06 §3）
          model: dto.model ?? dto.provider,
          baseUrl: dto.baseUrl ?? null,
          apiKeyEnc: dto.apiKey ? encryptSecret(dto.apiKey, this.encryptionKey) : null,
          dimensions: dto.dimensions ?? null,
          temperature: (dto.temperature ?? 0.7).toFixed(2),
          maxTokens: dto.maxTokens ?? null,
          isSelected: !existing,
          createdBy: userId,
        })
        .returning();
      if (!row) {
        throw new BizException(ErrorCode.INTERNAL, '模型创建失败');
      }
      return toAiModelView(row);
    });
  }

  async update(orgId: string, id: string, dto: UpdateAiModelDto): Promise<AiModelView> {
    return withOrg(this.db, orgId, async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.aiModel)
        .where(and(eq(schema.aiModel.id, id), eq(schema.aiModel.orgId, orgId)))
        .limit(1);
      if (!current) {
        throw new BizException(ErrorCode.NOT_FOUND, '模型不存在');
      }
      if (dto.name && dto.name !== current.name) {
        const [dup] = await tx
          .select({ id: schema.aiModel.id })
          .from(schema.aiModel)
          .where(
            and(
              eq(schema.aiModel.orgId, orgId),
              eq(schema.aiModel.type, current.type),
              eq(schema.aiModel.name, dto.name),
            ),
          )
          .limit(1);
        if (dup) {
          throw new BizException(ErrorCode.CONFLICT, '同名模型已存在');
        }
      }
      if (current.type === 'search') {
        // 合并后校验：未传即沿用现值（baseUrl 显式 null = 清除端点，不能吞并现值）
        assertSearchUsable(
          dto.provider ?? current.provider,
          dto.baseUrl !== undefined ? dto.baseUrl : current.baseUrl,
          dto.apiKey !== undefined || current.apiKeyEnc !== null,
        );
      } else if (current.type === 'embedding') {
        // 合并后校验：未传即沿用现值
        assertEmbeddingUsable(
          dto.provider ?? current.provider,
          dto.dimensions ?? current.dimensions,
        );
      }

      const [row] = await tx
        .update(schema.aiModel)
        .set({
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.provider !== undefined && { provider: dto.provider }),
          ...(dto.model !== undefined && { model: dto.model }),
          ...(dto.baseUrl !== undefined && { baseUrl: dto.baseUrl }),
          ...(dto.apiKey !== undefined && {
            apiKeyEnc: encryptSecret(dto.apiKey, this.encryptionKey),
          }),
          ...(dto.dimensions !== undefined && { dimensions: dto.dimensions }),
          ...(dto.temperature !== undefined && { temperature: dto.temperature.toFixed(2) }),
          ...(dto.maxTokens !== undefined && { maxTokens: dto.maxTokens }),
          updatedAt: new Date(),
        })
        .where(eq(schema.aiModel.id, id))
        .returning();
      if (!row) {
        throw new BizException(ErrorCode.NOT_FOUND, '模型不存在');
      }
      return toAiModelView(row);
    });
  }

  async remove(orgId: string, id: string): Promise<{ ok: true }> {
    return withOrg(this.db, orgId, async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.aiModel)
        .where(and(eq(schema.aiModel.id, id), eq(schema.aiModel.orgId, orgId)))
        .limit(1);
      if (!current) {
        throw new BizException(ErrorCode.NOT_FOUND, '模型不存在');
      }
      await tx.delete(schema.aiModel).where(eq(schema.aiModel.id, id));

      // 删除的是当前生效模型 → 回退到该 type 最早创建的剩余模型
      if (current.isSelected) {
        const [fallback] = await tx
          .select({ id: schema.aiModel.id })
          .from(schema.aiModel)
          .where(and(eq(schema.aiModel.orgId, orgId), eq(schema.aiModel.type, current.type)))
          .orderBy(asc(schema.aiModel.createdAt))
          .limit(1);
        if (fallback) {
          await tx
            .update(schema.aiModel)
            .set({ isSelected: true, updatedAt: new Date() })
            .where(eq(schema.aiModel.id, fallback.id));
        }
      }
      return { ok: true as const };
    });
  }

  async select(orgId: string, dto: AiModelSelectionDto): Promise<AiModelsView> {
    return withOrg(this.db, orgId, async (tx) => {
      if (dto.modelId !== null) {
        const [target] = await tx
          .select()
          .from(schema.aiModel)
          .where(and(eq(schema.aiModel.id, dto.modelId), eq(schema.aiModel.orgId, orgId)))
          .limit(1);
        if (!target) {
          throw new BizException(ErrorCode.NOT_FOUND, '模型不存在');
        }
        if (target.type !== dto.type) {
          throw new BizException(ErrorCode.BIZ_VALIDATION, '模型类型不匹配');
        }
      }
      // 先清空该 type 现有选中，再置目标（满足部分唯一索引约束）
      await tx
        .update(schema.aiModel)
        .set({ isSelected: false, updatedAt: new Date() })
        .where(
          and(
            eq(schema.aiModel.orgId, orgId),
            eq(schema.aiModel.type, dto.type),
            eq(schema.aiModel.isSelected, true),
          ),
        );
      if (dto.modelId !== null) {
        await tx
          .update(schema.aiModel)
          .set({ isSelected: true, updatedAt: new Date() })
          .where(eq(schema.aiModel.id, dto.modelId));
      }
      return this.toView(tx, orgId);
    });
  }

  /**
   * 解析某 type 当前选中的模型（含解密后的 apiKey），供运行时（LLM Gateway / Embedding Provider）消费。
   * 未配置选中模型返回 null，由调用方按各自缺省链兜底。
   * 实现复用 runtime（与 LlmGateway / Embedding 解析同一份逻辑，避免口径漂移）。
   */
  async resolveActiveModel(
    orgId: string,
    type: 'llm' | 'embedding' | 'search',
  ): Promise<ActiveAiModel | null> {
    return resolveActiveModel(this.db, orgId, type, this.encryptionKey);
  }

  private async toView(tx: Tx, orgId: string): Promise<AiModelsView> {
    const rows = await tx
      .select()
      .from(schema.aiModel)
      .where(eq(schema.aiModel.orgId, orgId))
      .orderBy(asc(schema.aiModel.type), asc(schema.aiModel.createdAt));
    const selection: AiModelsView['selection'] = { llm: null, embedding: null, search: null };
    for (const row of rows) {
      if (row.isSelected) {
        selection[row.type] = row.id;
      }
    }
    return { models: rows.map(toAiModelView), selection };
  }

  private get encryptionKey(): string {
    return this.env.env.ENCRYPTION_KEY;
  }
}

// ===== helpers =====

/**
 * embedding 模型可用性校验：provider 必须已实现，且维度必须与知识索引列一致。
 * 维度不一致会在入库时报 PostgreSQL 维度不匹配，故在此前置拦截并给出可读错误。
 */
function assertEmbeddingUsable(provider: string, dimensions: number | null): void {
  if (!EMBEDDING_PROVIDERS.includes(provider)) {
    throw new BizException(
      ErrorCode.BIZ_VALIDATION,
      `向量模型仅支持 ${EMBEDDING_PROVIDERS.join(' / ')} 提供方`,
    );
  }
  if (dimensions === null) {
    throw new BizException(ErrorCode.BIZ_VALIDATION, '向量模型需指定向量维度');
  }
  if (dimensions !== KNOWLEDGE_EMBEDDING_DIMENSIONS) {
    throw new BizException(
      ErrorCode.BIZ_VALIDATION,
      `向量维度需为 ${KNOWLEDGE_EMBEDDING_DIMENSIONS}（与知识索引一致）`,
    );
  }
}

/**
 * search 供应商可用性校验：provider 必须已实现；http（Serper 兼容）必须有接口地址与 API Key，
 * 否则 worker 侧 web_search/site_crawl 会在首次调用时才失败（前置拦截给出可读错误，06 §3）。
 */
function assertSearchUsable(provider: string, baseUrl: string | null, hasApiKey: boolean): void {
  if (!SEARCH_PROVIDERS.includes(provider)) {
    throw new BizException(
      ErrorCode.BIZ_VALIDATION,
      `搜索供应商仅支持 ${SEARCH_PROVIDERS.join(' / ')} 提供方`,
    );
  }
  if (provider === 'http' && !baseUrl) {
    throw new BizException(ErrorCode.BIZ_VALIDATION, 'http 搜索供应商需配置接口地址');
  }
  if (provider === 'http' && !hasApiKey) {
    throw new BizException(ErrorCode.BIZ_VALIDATION, 'http 搜索供应商需配置 API Key');
  }
}

function toAiModelView(row: typeof schema.aiModel.$inferSelect): AiModelView {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    provider: row.provider,
    model: row.model,
    baseUrl: row.baseUrl,
    dimensions: row.dimensions,
    temperature: row.temperature,
    maxTokens: row.maxTokens,
    hasApiKey: row.apiKeyEnc !== null,
    isSelected: row.isSelected,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
