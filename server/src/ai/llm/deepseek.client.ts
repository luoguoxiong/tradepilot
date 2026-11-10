import { z } from 'zod';

import { logger } from '../../logger';
import {
  ChatJsonOptions,
  LlmClient,
  LlmOutputError,
  LlmResult,
  LlmUnavailableError,
} from './types';

export type { LlmClient };

/**
 * DeepSeek（OpenAI 兼容）客户端。
 * 实现依据官方文档（2026-11 核对）：
 * https://api-docs.deepseek.com/api/create-chat-completion
 * - POST {base}/chat/completions，response_format {type:'json_object'}，但**必须**在提示中自行要求输出 JSON
 * - 模型输出非 JSON 时会被替换为空格 → 空内容按无效输出处理
 * - finish_reason='length' 表示截断 → 按无效输出处理
 * - temperature 默认 1（我们显式用低温）；max_tokens 默认 8K（显式传入控制成本）
 * - usage: prompt_tokens / completion_tokens
 */
const ApiResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().default(0),
      completion_tokens: z.number().int().nonnegative().default(0),
    })
    .default({ prompt_tokens: 0, completion_tokens: 0 }),
  model: z.string().default('unknown'),
});

export interface DeepSeekConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

interface ApiMessage {
  role: 'system' | 'user';
  content: string;
}

interface ApiResult {
  content: string | null;
  finishReason: string | null;
  usage: { promptTokens: number; completionTokens: number };
  model: string;
}

export class DeepSeekLlmClient implements LlmClient {
  constructor(private readonly cfg: DeepSeekConfig) {}

  async chatJson<T>(options: ChatJsonOptions<T>): Promise<LlmResult<T>> {
    const messages: ApiMessage[] = [
      { role: 'system', content: options.system },
      { role: 'user', content: options.user },
    ];

    let lastError: Error | null = null;
    // 校验失败纠错重试一次（附失败原因）；官方要求提示中自行要求 JSON 输出
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { content, finishReason, usage, model } = await this.request(messages, options);
        if (content === null || content.trim() === '') {
          throw new LlmOutputError('EMPTY_CONTENT', '模型返回空内容（JSON 模式下非 JSON 输出会被替换为空格）');
        }
        if (finishReason === 'length') {
          throw new LlmOutputError('TRUNCATED', `输出被 max_tokens=${options.maxTokens} 截断`);
        }

        let raw: unknown;
        try {
          raw = JSON.parse(content);
        } catch {
          throw new LlmOutputError('INVALID_JSON', '模型输出不是合法 JSON');
        }

        const parsed = options.schema.safeParse(raw);
        if (!parsed.success) {
          const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
          messages.push({
            role: 'user',
            content: `你上次的输出未通过校验：${issues}。请只输出修正后的合法 JSON，不要包含其他文本。`,
          });
          lastError = new LlmOutputError('INVALID_JSON', `schema 校验失败: ${issues}`);
          continue;
        }
        return { data: parsed.data, usage: { ...usage, model } };
      } catch (err) {
        if (err instanceof LlmOutputError) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    logger.warn({ err: lastError?.message }, 'LLM 输出纠错重试耗尽');
    throw lastError ?? new LlmOutputError('INVALID_JSON', 'LLM 输出不可用');
  }

  /** 单次 HTTP 请求；网络错误/429/5xx 重试一次；响应结构按不可信输入校验 */
  private async request(messages: ApiMessage[], options: ChatJsonOptions<unknown>): Promise<ApiResult> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 60000);

    let lastError: Error | null = null;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.cfg.apiKey}`,
            },
            body: JSON.stringify({
              model: this.cfg.model,
              messages,
              temperature: options.temperature ?? 0.2,
              max_tokens: options.maxTokens,
              response_format: { type: 'json_object' },
            }),
            signal: controller.signal,
          });

          if (res.status === 429 || res.status >= 500) {
            lastError = new LlmUnavailableError(`LLM 上游 HTTP ${res.status}，重试中`);
            continue;
          }
          if (!res.ok) {
            const bodyText = await res.text().catch(() => '');
            throw new LlmUnavailableError(`LLM 请求失败 HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
          }

          const parsed = ApiResponseSchema.parse(await res.json());
          return {
            content: parsed.choices[0]?.message.content ?? null,
            finishReason: parsed.choices[0]?.finish_reason ?? null,
            usage: {
              promptTokens: parsed.usage.prompt_tokens,
              completionTokens: parsed.usage.completion_tokens,
            },
            model: parsed.model,
          };
        } catch (err) {
          if (err instanceof LlmUnavailableError) {
            lastError = err;
            continue;
          }
          if (err instanceof z.ZodError) {
            throw new LlmUnavailableError('LLM 响应结构异常（第三方响应视为不可信输入）', err.flatten());
          }
          if (err instanceof Error && err.name === 'AbortError') {
            throw new LlmUnavailableError(`LLM 请求超时（${this.cfg.timeoutMs ?? 60000}ms）`);
          }
          throw err;
        }
      }
      logger.warn({ err: String(lastError) }, 'LLM 请求重试耗尽');
      throw lastError ?? new LlmUnavailableError('LLM 请求失败');
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 工厂：无 Key 返回 null（调用方降级为确定性规则实现并标注 mock） */
export function createLlmClient(): DeepSeekLlmClient | null {
  const env = process.env;
  if (!env.LLM_API_KEY) return null;
  return new DeepSeekLlmClient({
    baseUrl: env.LLM_BASE_URL || 'https://api.deepseek.com',
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL || 'deepseek-flash',
    timeoutMs: 60000,
  });
}
