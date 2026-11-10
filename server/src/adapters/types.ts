/**
 * Adapter 层契约（docs/architecture.md §4 为准，变更须同步文档）。
 * 第三方 API 调用只允许出现在本目录与 src/ai/。
 */

/** 数据来源标记：真实 API 返回具体提供方，Mock 恒为 'demo' */
export type DataSource = 'google' | 'apollo' | `customs:${string}` | `enrichment:${string}` | 'demo';

export interface AdapterContext {
  /** 调用方用户 ID（integrations 按用户取 Key） */
  userId: string;
  timeoutMs?: number;
}

/** 第三方调用失败统一错误（超时/限流/配额超限/5xx） */
export class AdapterError extends Error {
  constructor(
    public readonly code: 'TIMEOUT' | 'RATE_LIMITED' | 'QUOTA_EXCEEDED' | 'UPSTREAM_ERROR' | 'BAD_RESPONSE',
    message: string,
    public readonly upstream?: unknown,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

// ---------- CompanySearchAdapter（Google 搜索） ----------

export interface CompanySearchInput {
  productKeywords: string[];
  country: string;
  companyTypes: string[];
  industryKeywords?: string[];
  limit: number;
  page?: number;
}

export interface CompanySearchResult {
  name: string;
  website?: string;
  country: string;
  description?: string;
  mainProducts?: string[];
  email?: string;
  linkedinUrl?: string;
  source: DataSource;
  searchedAt: Date;
}

export interface CompanySearchAdapter {
  readonly name: 'CompanySearchAdapter';
  search(input: CompanySearchInput, ctx: AdapterContext): Promise<CompanySearchResult[]>;
}
