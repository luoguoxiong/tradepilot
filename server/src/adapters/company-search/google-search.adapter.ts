import { z } from 'zod';

import type {
  AdapterContext,
  CompanySearchAdapter,
  CompanySearchInput,
  CompanySearchResult,
} from '../types';
import { AdapterError } from '../types';

export interface GoogleSearchConfig {
  apiKey: string;
  cx: string;
}

/** Google Custom Search JSON API 响应（第三方响应视为不可信输入，zod 校验后才进业务） */
const GoogleResponseSchema = z.object({
  items: z
    .array(
      z.object({
        title: z.string(),
        link: z.string().url(),
        snippet: z.string().optional(),
      }),
    )
    .default([]),
});

/** Real 实现：Google Programmable Search JSON API（仅填充数据源真实提供的字段，禁止虚构） */
export class GoogleSearchAdapter implements CompanySearchAdapter {
  readonly name = 'CompanySearchAdapter' as const;

  constructor(private readonly config: GoogleSearchConfig) {}

  async search(
    input: CompanySearchInput,
    ctx: AdapterContext,
  ): Promise<CompanySearchResult[]> {
    const query = buildQuery(input);
    const num = Math.min(input.limit, 10);
    const start = ((input.page ?? 1) - 1) * 10 + 1;
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', this.config.apiKey);
    url.searchParams.set('cx', this.config.cx);
    url.searchParams.set('q', query);
    url.searchParams.set('num', String(num));
    url.searchParams.set('start', String(start));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs ?? 15000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.status === 429) {
        throw new AdapterError('RATE_LIMITED', 'Google Search rate limited');
      }
      if (!res.ok) {
        throw new AdapterError('UPSTREAM_ERROR', `Google Search API HTTP ${res.status}`);
      }
      const parsed = GoogleResponseSchema.parse(await res.json());
      const now = new Date();
      return parsed.items.map((item) => ({
        // Google 只返回标题/摘要/链接：mainProducts/email 等可选字段由 enriching:enrich 补齐，此处留空
        name: cleanTitle(item.title),
        website: item.link,
        country: input.country,
        description: item.snippet,
        source: 'google' as const,
        searchedAt: now,
      }));
    } catch (err) {
      if (err instanceof AdapterError) throw err;
      if (err instanceof z.ZodError) {
        throw new AdapterError('BAD_RESPONSE', 'Google Search response failed schema validation', err.flatten());
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AdapterError('TIMEOUT', 'Google Search API timed out');
      }
      throw new AdapterError('UPSTREAM_ERROR', 'Google Search API request failed', String(err));
    } finally {
      clearTimeout(timer);
    }
  }
}

function buildQuery(input: CompanySearchInput): string {
  const parts = [
    ...input.productKeywords,
    ...input.industryKeywords ?? [],
    ...input.companyTypes,
    `suppliers ${countryName(input.country)}`,
    'B2B',
  ];
  return parts.filter(Boolean).join(' ');
}

/** 标题里 Google 常附加「- 公司名 | Home」，只保留首段并去尾部符号 */
function cleanTitle(title: string): string {
  return title.split(/\s[|·–—-]\s/)[0]?.trim() || title.trim();
}

function countryName(code: string): string {
  const map: Record<string, string> = { US: 'USA', CA: 'Canada' };
  return map[code] ?? code;
}
