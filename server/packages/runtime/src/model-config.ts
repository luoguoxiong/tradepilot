/**
 * AI 模型配置解析（16 FR-10 扩展）：把「系统设置 → AI 模型配置」中 org 选用的模型
 * 解析为运行时可直接消费的配置，供 LlmGateway（type=llm）、Embedding Provider（type=embedding）
 * 与 Search Provider（type=search）共用。
 *
 * 缺省链：台账选用（ai_model.is_selected）→ 字段级缺省（baseUrl/apiKey/model）；
 * 未选用模型时由启动装配明确报错（不再回落 mock）。
 * 凭据：ai_model.api_key_enc 为 AES-256-GCM 密文（08 §2），仅在此解密回填，永不出库明文。
 */
import { and, eq } from 'drizzle-orm';
import { decryptSecret } from '@tradepilot/core';
import { schema, withOrg, type Db, type Tx } from '@tradepilot/db';

export type AiModelKind = 'llm' | 'embedding' | 'search';

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

/**
 * embedding 字段级缺省（baseUrl/apiKey/model 未显式给出时逐项回落）。
 * 说明：模型/供应商配置统一由「系统设置 → AI 模型配置」维护（仅 admin），不再读环境变量；
 * 未配置选用模型时由启动装配直接报错，不再提供 mock 兜底。
 */
export interface EmbeddingFallbackOptions {
  provider: 'openai';
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** embedding 字段级缺省（openai 兼容端点），仅用于补齐台账未显式给出的字段 */
export const EMBEDDING_FIELD_DEFAULTS: EmbeddingFallbackOptions = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'text-embedding-3-small',
};

/** 与 integrations `EmbeddingOptions` 结构一致（此处不引包，避免 runtime → integrations 依赖） */
export interface EmbeddingProviderConfig {
  provider: 'openai';
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions?: number;
}

/**
 * 台账选用 → EmbeddingOptions：org 选用优先，字段缺省逐项回落字段级缺省。
 * provider 口径：仅 openai 走 OpenAI 兼容 /embeddings；其余值视为不支持的提供方（明确报错，不再回落 mock）。
 * 注：active=null 时原样回落 fallback（供测试/离线显式注入），生产装配在调用前已对 null 明确报错。
 */
export function toEmbeddingProviderConfig(
  active: ActiveModelConfig | null,
  fallback: EmbeddingFallbackOptions,
): EmbeddingProviderConfig {
  if (!active) {
    return { ...fallback };
  }
  if (active.provider !== 'openai') {
    throw new Error(`不支持的向量模型提供方：${active.provider}（仅支持 openai 兼容协议）`);
  }
  return {
    provider: 'openai',
    baseUrl: active.baseUrl ?? fallback.baseUrl,
    apiKey: active.apiKey ?? fallback.apiKey,
    model: active.model || fallback.model,
    ...(active.dimensions !== undefined && { dimensions: active.dimensions }),
  };
}

/**
 * search 字段级缺省（baseUrl/apiKey 未显式给出时逐项回落）。
 * 说明：模型/供应商配置统一由「系统设置 → AI 模型配置」维护（仅 admin），不再读环境变量；
 * 未配置选用供应商时由启动装配直接报错，不再提供 mock 兜底。
 */
export interface SearchFallbackOptions {
  provider: 'http';
  baseUrl: string;
  apiKey: string;
}

/** search 字段级缺省（Serper 兼容端点），仅用于补齐台账未显式给出的字段 */
export const SEARCH_FIELD_DEFAULTS: SearchFallbackOptions = {
  provider: 'http',
  baseUrl: 'https://google.serper.dev',
  apiKey: '',
};

/** 与 integrations `createSearchProvider` 入参结构一致（此处不引包，避免 runtime → integrations 依赖） */
export interface SearchProviderConfig {
  provider: 'http';
  baseUrl: string;
  apiKey: string;
}

/**
 * 台账选用 → 搜索供应商配置：org 选用优先，字段缺省逐项回落字段级缺省。
 * provider 口径：仅 http 走 Serper 兼容搜索 API；其余值视为不支持的供应商（明确报错，不再回落 mock）。
 * 注：active=null 时原样回落 fallback（供测试/离线显式注入），生产装配在调用前已对 null 明确报错。
 *
 * 注：search 类型无「模型标识」，`model` 不参与供应商构造（仅作台账占位，06 §3）。
 */
export function toSearchProviderConfig(
  active: ActiveModelConfig | null,
  fallback: SearchFallbackOptions,
): SearchProviderConfig {
  if (!active) {
    return { ...fallback };
  }
  if (active.provider !== 'http') {
    throw new Error(`不支持的搜索供应商：${active.provider}（仅支持 http 即 Serper 兼容 API）`);
  }
  return {
    provider: 'http',
    baseUrl: active.baseUrl ?? fallback.baseUrl,
    apiKey: active.apiKey ?? fallback.apiKey,
  };
}
