/**
 * 嵌入服务适配（后端技术方案 07 §2 ④ / 06 §4）：
 * - openai：OpenAI 兼容 /embeddings 接口（text-embedding-3-small，1536 维，ER 06 vector(1536)）。
 * 进程级注入（同 email-send-config 模式）：api/worker 启动时 setEmbeddingProviderFactory 一次，
 * 未注入即明确报错（无 mock 兜底）。
 */

export interface EmbeddingProvider {
  readonly dimensions: number;
  readonly model: string;
  /** 批量嵌入（调用方保证 ≤100 条/批，07 §2 ④） */
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingOptions {
  provider: 'openai';
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 返回的向量维度（须与 knowledge_chunk.embedding 一致） */
  dimensions?: number;
}

/**
 * 知识索引向量维度硬约束：`knowledge_chunk.embedding` 为 `vector(1536)`（ER 06），
 * 选用的 embedding 模型维度必须一致，否则入库时报维度不匹配。
 */
export const KNOWLEDGE_EMBEDDING_DIMENSIONS = 1536;

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  readonly model: string;

  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      model: string;
      dimensions?: number;
    },
  ) {
    this.model = options.model;
    this.dimensions = options.dimensions ?? 1536;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const url = `${this.options.baseUrl.replace(/\/$/, '')}/embeddings`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify({ model: this.options.model, input: texts }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`嵌入服务请求失败（${res.status}）: ${detail.slice(0, 200)}`);
    }
    const json = (await res.json()) as { data?: { embedding: number[] }[] };
    const data = json.data ?? [];
    if (data.length !== texts.length) {
      throw new Error(`嵌入服务返回条数不匹配: 期望 ${texts.length}，实际 ${data.length}`);
    }
    return data.map((d) => d.embedding);
  }
}

export function createEmbeddingProvider(options: EmbeddingOptions): EmbeddingProvider {
  if (options.provider !== 'openai') {
    throw new Error(`不支持的向量模型提供方：${options.provider}（仅支持 openai 兼容协议）`);
  }
  return new OpenAiEmbeddingProvider({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    model: options.model,
    dimensions: options.dimensions,
  });
}

// ===== 进程级注入（api/worker 启动时一次）=====
// 16 FR-10 扩展后为「按 org 解析」：工厂可读库拿到 org 选用的 embedding 模型（api/worker 侧装配）。
// 未注册工厂时明确报错（无 mock 兜底）。

/** org → provider 工厂（异步：需读该 org 的 AI 模型选用配置） */
export type EmbeddingProviderFactory = (
  orgId?: string,
) => EmbeddingProvider | Promise<EmbeddingProvider>;

let factory: EmbeddingProviderFactory | null = null;

/** 注册 org 级解析工厂（api/worker 启动时一次） */
export function setEmbeddingProviderFactory(next: EmbeddingProviderFactory): void {
  factory = next;
}

export async function getEmbeddingProvider(orgId?: string): Promise<EmbeddingProvider> {
  if (factory) {
    return await factory(orgId);
  }
  throw new Error(
    `Embedding provider 未配置（org=${orgId ?? '-'}）：` +
      '请由 api/worker 启动装配注入（setEmbeddingProviderFactory）；无 mock 兜底',
  );
}
