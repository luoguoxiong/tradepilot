/**
 * 嵌入服务适配（后端技术方案 07 §2 ④ / 06 §4）：
 * - mock：文本派生确定性向量（跨进程一致——API 侧 query 与 worker 侧 chunk 必须同源），
 *   测试与离线开发可用；
 * - openai：OpenAI 兼容 /embeddings 接口（text-embedding-3-small，1536 维，ER 06 vector(1536)）。
 * 进程级注入（同 email-send-config 模式）：api/worker 启动时 configureEmbedding 一次。
 */
import { createHash } from 'node:crypto';

export interface EmbeddingProvider {
  readonly dimensions: number;
  readonly model: string;
  /** 批量嵌入（调用方保证 ≤100 条/批，07 §2 ④） */
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingOptions {
  provider: 'mock' | 'openai';
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 真实 provider 返回的向量维度（须与 knowledge_chunk.embedding 一致） */
  dimensions?: number;
  /** mock 维度（对齐 ER 06 vector(1536)） */
  mockDimensions?: number;
}

export const MOCK_EMBEDDING_DIMENSIONS = 1536;

/**
 * 知识索引向量维度硬约束：`knowledge_chunk.embedding` 为 `vector(1536)`（ER 06），
 * 选用的 embedding 模型维度必须一致，否则入库时报维度不匹配。
 */
export const KNOWLEDGE_EMBEDDING_DIMENSIONS = 1536;

/**
 * mock 确定性向量：文本 sha256 派生种子 → 分桶伪随机 + L2 归一。
 * 同文本恒定同向量（跨进程/跨包一致），不同文本高维近似正交——混合检索的向量路
 * 在 mock 下可复算可断言，真实语义随 openai provider。
 */
export function mockEmbed(text: string, dimensions = MOCK_EMBEDDING_DIMENSIONS): number[] {
  const vec = new Float64Array(dimensions);
  let seed = Buffer.from(text, 'utf8');
  let filled = 0;
  while (filled < dimensions) {
    const digest = createHash('sha256').update(seed).digest();
    for (let i = 0; i < digest.length && filled < dimensions; i += 4) {
      // 32bit → [-1, 1)
      const n = digest.readUInt32BE(i) / 0x1_0000_0000;
      vec[filled] = n * 2 - 1;
      filled += 1;
    }
    seed = digest;
  }
  let norm = 0;
  for (const v of vec) {
    norm += v * v;
  }
  norm = Math.sqrt(norm) || 1;
  return Array.from(vec, (v) => v / norm);
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  readonly model = 'mock-embedding-1';

  constructor(dimensions = MOCK_EMBEDDING_DIMENSIONS) {
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => mockEmbed(t, this.dimensions));
  }
}

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
  if (options.provider === 'openai') {
    return new OpenAiEmbeddingProvider({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model: options.model,
      dimensions: options.dimensions,
    });
  }
  return new MockEmbeddingProvider(options.mockDimensions);
}

// ===== 进程级注入（api/worker 启动时一次）=====
// 16 FR-10 扩展后为「按 org 解析」：工厂可读库拿到 org 选用的 embedding 模型（api/worker 侧装配），
// 未注册工厂时回落到 mock。configureEmbedding 保留为静态注册（单测/离线演练）。

/** org → provider 工厂（异步：需读该 org 的 AI 模型选用配置） */
export type EmbeddingProviderFactory = (
  orgId?: string,
) => EmbeddingProvider | Promise<EmbeddingProvider>;

let factory: EmbeddingProviderFactory | null = null;
let defaultProvider: EmbeddingProvider | null = null;

/** 注册 org 级解析工厂（api/worker 启动时一次） */
export function setEmbeddingProviderFactory(next: EmbeddingProviderFactory): void {
  factory = next;
}

/** 静态注册（忽略 orgId）：等价于固定 provider，单测与离线演练使用 */
export function configureEmbedding(provider: EmbeddingProvider): void {
  factory = () => provider;
}

export async function getEmbeddingProvider(orgId?: string): Promise<EmbeddingProvider> {
  if (factory) {
    return await factory(orgId);
  }
  defaultProvider ??= new MockEmbeddingProvider();
  return defaultProvider;
}
