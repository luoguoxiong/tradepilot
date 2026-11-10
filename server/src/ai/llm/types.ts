import type { z } from 'zod';

/**
 * LLM 客户端契约（OpenAI 兼容协议；DeepSeek 官方文档核实：
 * https://api-docs.deepseek.com/api/create-chat-completion）
 */
export interface ChatJsonOptions<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  /** 显式设置 max_tokens（官方默认 8K，长输出必须显式控制成本） */
  maxTokens: number;
  /** 评分类低温度（0.2）保证稳定性；官方默认 1 */
  temperature?: number;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  model: string;
}

export interface LlmResult<T> {
  data: T;
  usage: LlmUsage;
}

export interface LlmClient {
  /** 结构化 JSON 输出：内部完成「JSON 解析 + zod 校验，失败重试一次」 */
  chatJson<T>(options: ChatJsonOptions<T>): Promise<LlmResult<T>>;
}

/** LLM 输出不可用（非法 JSON/截断/空内容），重试耗尽后抛出 → 服务层映射 503 */
export class LlmOutputError extends Error {
  constructor(
    public readonly code: 'INVALID_JSON' | 'TRUNCATED' | 'EMPTY_CONTENT',
    message: string,
  ) {
    super(message);
    this.name = 'LlmOutputError';
  }
}

/** LLM 服务不可用（网络/5xx/限流重试耗尽） */
export class LlmUnavailableError extends Error {
  constructor(message: string, public readonly upstream?: unknown) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}
