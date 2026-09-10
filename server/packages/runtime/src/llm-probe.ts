/**
 * LLM 连通性探活（16 FR-10 扩展）：保存「AI 模型配置」前的极小化真实调用校验。
 * provider 端点口径与 LlmGateway.createChatModel 保持一致（openai/azure/deepseek/anthropic），
 * 避免台账校验通过但运行时调用才失败。mock provider 离线可用，不发真实请求。
 */
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import type { LlmProvider } from './llm-gateway.js';

export interface LlmProbeOptions {
  provider: LlmProvider;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  /** 探活超时（默认 15s，防止保存按钮长时间挂起） */
  timeoutMs?: number;
}

export interface LlmProbeResult {
  ok: boolean;
  /** ok=false 时的可读原因（截断，直接展示给用户） */
  message?: string;
  latencyMs: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

/** 探活请求最大输出 token（仅验证连通，尽量压低成本） */
const PROBE_MAX_TOKENS = 16;

/**
 * 向目标 LLM 发一条极简 prompt 验证端点/凭据/模型是否可用。
 * 任何异常都收敛为 `{ ok: false, message }`，由调用方决定是否阻断保存。
 */
export async function probeLlmConnection(opts: LlmProbeOptions): Promise<LlmProbeResult> {
  if (opts.provider === 'mock') {
    return { ok: true, latencyMs: 0 };
  }
  if (!opts.apiKey) {
    return { ok: false, message: '缺少 API Key，无法验证连通性', latencyMs: 0 };
  }
  if (!opts.model) {
    return { ok: false, message: '缺少模型标识，无法验证连通性', latencyMs: 0 };
  }

  const startedAt = Date.now();
  try {
    const model = createProbeModel(opts);
    await model.invoke([{ role: 'user', content: 'ping' }], {
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS),
    });
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (err) {
    return {
      ok: false,
      message: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      latencyMs: Date.now() - startedAt,
    };
  }
}

/** 构造探活客户端（与 LlmGateway.createChatModel 的 provider 分支同口径） */
function createProbeModel(opts: LlmProbeOptions) {
  const { provider, model, apiKey, baseUrl } = opts;
  if (provider === 'openai' || provider === 'azure') {
    return new ChatOpenAI({
      model,
      apiKey,
      maxTokens: PROBE_MAX_TOKENS,
      temperature: 0,
      configuration: baseUrl ? { baseURL: baseUrl } : undefined,
    });
  }
  if (provider === 'deepseek') {
    return new ChatOpenAI({
      model,
      apiKey,
      maxTokens: PROBE_MAX_TOKENS,
      temperature: 0,
      configuration: { baseURL: baseUrl ?? 'https://api.deepseek.com' },
    });
  }
  // anthropic
  return new ChatAnthropic({
    model,
    anthropicApiKey: apiKey,
    maxTokens: PROBE_MAX_TOKENS,
    temperature: 0,
  });
}
