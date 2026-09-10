import { z } from 'zod';

/**
 * AI 模型配置契约（接口 16 FR-10 扩展）：
 * - type=llm：普通大模型，使用 provider/model/temperature/maxTokens；
 * - type=embedding：向量化模型，使用 provider/model/dimensions；
 * - apiKey 仅请求携带，AES-256-GCM 加密落库（08 §2），响应永不回显明文。
 * 权限：变更仅 admin（03 §4）；读取 admin+manager（settings: view）。
 */

export const aiModelTypes = ['llm', 'embedding'] as const;

/** 与 runtime LlmGateway / integrations EmbeddingOptions 的 provider 对齐 */
export const aiModelProviders = ['mock', 'openai', 'anthropic', 'deepseek', 'azure'] as const;

export const createAiModelSchema = z.object({
  type: z.enum(aiModelTypes),
  name: z.string().min(1, '名称必填').max(64),
  provider: z.enum(aiModelProviders),
  model: z.string().min(1, '模型标识必填').max(128),
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

export const aiModelSelectionSchema = z.object({
  type: z.enum(aiModelTypes),
  /** 选中该 type 下的模型 id；null 表示取消选用 */
  modelId: z.string().min(1).max(64).nullable(),
});
export type AiModelSelectionDto = z.infer<typeof aiModelSelectionSchema>;
