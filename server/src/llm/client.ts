import { config } from '../config.js';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 统一 LLM 调用层：超时/重试/JSON 校验重试/降级模型，全链路埋点日志 */
async function callModel(model: string, messages: ChatMessage[], jsonMode: boolean): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.llm.timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llm.apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.4,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const data: any = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('LLM 返回为空');
    console.log(`[llm] model=${model} tokens=${data?.usage?.total_tokens ?? '?'} cost=${Date.now() - started}ms`);
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/** 普通对话：指数退避重试 2 次，最后尝试降级模型 */
export async function chat(messages: ChatMessage[], jsonMode = true): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return await callModel(config.llm.model, messages, jsonMode);
    } catch (e) {
      lastErr = e;
      console.warn(`[llm] 第${i + 1}次调用失败: ${(e as Error).message}`);
      if (i < 2) await sleep(1000 * 2 ** i);
    }
  }
  if (config.llm.fallbackModel) {
    try {
      console.warn('[llm] 降级到备用模型');
      return await callModel(config.llm.fallbackModel, messages, jsonMode);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('LLM 调用失败');
}

/**
 * JSON 模式调用：schema 校验失败会把错误信息回传给模型重试一次（多层容错）
 * @param validate 返回 null 表示通过，否则返回错误描述
 */
export async function chatJson<T>(
  messages: ChatMessage[],
  validate: (obj: unknown) => string | null,
): Promise<T> {
  const extract = (text: string): unknown => {
    // 容错：剥掉可能的 ```json 包裹
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    return JSON.parse((m ? m[1] : text).trim());
  };
  let errs: string[] = [];
  const convo = [...messages];
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await chat(convo, true);
    let obj: unknown;
    try {
      obj = extract(text);
    } catch {
      errs = ['输出不是合法 JSON'];
      convo.push({ role: 'assistant', content: text });
      convo.push({ role: 'user', content: `输出解析失败：${errs[0]}。请只输出符合要求的 JSON，不要任何其他文字。` });
      continue;
    }
    const err = validate(obj);
    if (!err) return obj as T;
    errs = [err];
    convo.push({ role: 'assistant', content: text });
    convo.push({ role: 'user', content: `输出校验失败：${err}。请修正后重新只输出 JSON。` });
  }
  throw new Error(`LLM 输出校验失败: ${errs.join('; ')}`);
}

export function requireStringArray(obj: any, key: string, min = 0, max = 100): string | null {
  const v = obj?.[key];
  if (!Array.isArray(v)) return `${key} 必须是数组`;
  if (v.length < min) return `${key} 至少 ${min} 项`;
  if (v.length > max) return `${key} 最多 ${max} 项`;
  if (v.some((x) => typeof x !== 'string')) return `${key} 必须全是字符串`;
  return null;
}

export function optionalString(obj: any, key: string): string | null {
  const v = obj?.[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return `${key} 必须是字符串或 null`;
  return null;
}
