/**
 * AI 模型配置解析（16 FR-10 扩展）：把「系统设置 → AI 模型配置」中 org 选用的模型
 * 解析为运行时可直接消费的配置，供 LlmGateway（type=llm）与 Embedding Provider（type=embedding）共用。
 *
 * 缺省链：台账选用（ai_model.is_selected）→ 调用方各自的缺省（场景配置 / 环境变量 / mock）。
 * 凭据：ai_model.api_key_enc 为 AES-256-GCM 密文（08 §2），仅在此解密回填，永不出库明文。
 */
import { and, eq } from 'drizzle-orm';
import { decryptSecret } from '@tradepilot/core';
import { schema, withOrg, type Db, type Tx } from '@tradepilot/db';

export type AiModelKind = 'llm' | 'embedding';

/** 运行时可消费的模型配置（apiKey 已解密） */
export interface ActiveModelConfig {
  id: string;
  type: AiModelKind;
  name: string;
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  /** 仅 embedding：向量维度 */
  dimensions?: number;
  temperature: number;
  maxTokens?: number;
}

/**
 * 在已开启的租户事务内读取选用模型（调用方可与其它查询复用同一事务，避免额外往返）。
 * 未配置返回 null；encryptionKey 缺省（如未接密钥库的测试进程）时跳过 apiKey 解密。
 */
async function selectActiveModel(
  tx: Tx,
  orgId: string,
  type: AiModelKind,
  encryptionKey?: string,
): Promise<ActiveModelConfig | null> {
  const [row] = await tx
    .select()
    .from(schema.aiModel)
    .where(
      and(
        eq(schema.aiModel.orgId, orgId),
        eq(schema.aiModel.type, type),
        eq(schema.aiModel.isSelected, true),
      ),
    )
    .limit(1);
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    type,
    name: row.name,
    provider: row.provider,
    model: row.model,
    ...(row.baseUrl !== null && { baseUrl: row.baseUrl }),
    ...(row.apiKeyEnc !== null &&
      encryptionKey !== undefined && {
        apiKey: decryptSecret(row.apiKeyEnc, encryptionKey),
      }),
    ...(row.dimensions !== null && { dimensions: row.dimensions }),
    temperature: Number(row.temperature),
    ...(row.maxTokens !== null && { maxTokens: row.maxTokens }),
  };
}

/** 读取某 org 在 type 下「当前选用」的模型（自开事务）；未配置返回 null（由调用方兜底） */
export async function resolveActiveModel(
  db: Db,
  orgId: string,
  type: AiModelKind,
  encryptionKey?: string,
): Promise<ActiveModelConfig | null> {
  return withOrg(db, orgId, (tx) => selectActiveModel(tx, orgId, type, encryptionKey));
}

/** 环境变量兜底（api/worker 启动时注入，对齐 EMBEDDING_* 契约） */
export interface EmbeddingFallbackOptions {
  provider: 'mock' | 'openai';
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 与 integrations `EmbeddingOptions` 结构一致（此处不引包，避免 runtime → integrations 依赖） */
export interface EmbeddingProviderConfig {
  provider: 'mock' | 'openai';
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions?: number;
  mockDimensions?: number;
}

/**
 * 台账选用 → EmbeddingOptions：org 选用优先，字段缺省逐项回落环境变量。
 * provider 口径：openai 走 OpenAI 兼容 /embeddings；其余（含 mock）走确定性 mock 向量。
 */
export function toEmbeddingProviderConfig(
  active: ActiveModelConfig | null,
  fallback: EmbeddingFallbackOptions,
): EmbeddingProviderConfig {
  if (!active) {
    return { ...fallback };
  }
  return {
    provider: active.provider === 'openai' ? 'openai' : 'mock',
    baseUrl: active.baseUrl ?? fallback.baseUrl,
    apiKey: active.apiKey ?? fallback.apiKey,
    model: active.model || fallback.model,
    ...(active.dimensions !== undefined && {
      dimensions: active.dimensions,
      mockDimensions: active.dimensions,
    }),
  };
}
