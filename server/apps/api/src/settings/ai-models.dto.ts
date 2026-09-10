import { z } from 'zod';

/**
 * AI 模型配置契约（接口 16 FR-10 扩展）：
 * - type=llm：普通大模型，使用 provider/model/temperature/maxTokens；
 * - type=embedding：向量化模型，使用 provider/model/dimensions；
 * - type=search：搜索供应商，使用 provider（http=Serper 兼容 / mock）+ baseUrl + apiKey，
 *   无「模型标识」概念（model 缺省以 provider 占位，06 §3）；
 * - apiKey 仅请求携带，AES-256-GCM 加密落库（08 §2），响应永不回显明文。
 * 字段必填性随 type 而异，统一由 service 按 type 校验（与 embedding 维度同口径）。
 * 权限：仅 admin（03 §4）——模型/供应商配置属敏感配置，不开放给 manager。
 */

export const aiModelTypes = ['llm', 'embedding', 'search'] as const;

/**
 * 与 runtime LlmGateway / integrations EmbeddingOptions / SearchOptions 的 provider 并集对齐。
 * 各 type 可用子集由 service 按 type 白名单收窄（llm：openai/anthropic/deepseek/azure/mock；
 * embedding：mock/openai；search：http/mock）。
 */
export const aiModelProviders = [
  'mock',
  'openai',
  'anthropic',
  'deepseek',
  'azure',
  'http',
] as const;

export const createAiModelSchema = z.object({
  type: z.enum(aiModelTypes),
  name: z.string().min(1, '名称必填').max(64),
  provider: z.enum(aiModelProviders),
  /** 模型标识（llm/embedding 必填，由 service 校验；search 可省略，以 provider 占位） */
  model: z.string().min(1, '模型标识必填').max(128).optional(),
  baseUrl: z.string().url('baseUrl 需为合法 URL').max(512).optional(),
  /** 仅请求携带；AES-256-GCM 加密落库，响应永不回显 */
  apiKey: z.string().min(1).max(1024).optional(),
  /** embedding 向量维度（必填性由 service 按 type 校验） */
  dimensions: z.number().int().min(1).max(8192).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(200_000).optional(),
});
export type CreateAiModelDto = z.infer<typeof createAiModelSchema>;

export const updateAiModelSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  provider: z.enum(aiModelProviders).optional(),
  model: z.string().min(1).max(128).optional(),
  /** 显式 null 清除自定义端点 */
  baseUrl: z.string().url('baseUrl 需为合法 URL').max(512).nullable().optional(),
  apiKey: z.string().min(1).max(1024).optional(),
  dimensions: z.number().int().min(1).max(8192).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(200_000).optional(),
});
export type UpdateAiModelDto = z.infer<typeof updateAiModelSchema>;

/**
 * 保存前连通性验证契约：对目标配置做一次最小化真实调用，通过才允许落库。
 * 字段与 create/update 同源；编辑场景传 id，未显式提供的字段与凭据回退库中现值。
 */
export const verifyAiModelSchema = z.object({
  /** 编辑场景提供：未传字段/凭据回退库中现值（否则按新增口径校验） */
  id: z.string().min(1).max(64).optional(),
  type: z.enum(aiModelTypes),
  provider: z.enum(aiModelProviders),
  model: z.string().min(1).max(128).optional(),
  /** 显式 null 表示清空自定义端点 */
  baseUrl: z.string().url('baseUrl 需为合法 URL').max(512).nullable().optional(),
  apiKey: z.string().min(1).max(1024).optional(),
  dimensions: z.number().int().min(1).max(8192).optional(),
});
export type VerifyAiModelDto = z.infer<typeof verifyAiModelSchema>;

export const aiModelSelectionSchema = z.object({
  type: z.enum(aiModelTypes),
  /** 选中该 type 下的模型 id；null 表示取消选用 */
  modelId: z.string().min(1).max(64).nullable(),
});
export type AiModelSelectionDto = z.infer<typeof aiModelSelectionSchema>;
