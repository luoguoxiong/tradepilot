import { z } from 'zod';

import type {
  AdapterContext,
  CompanySearchAdapter,
  CompanySearchInput,
  CompanySearchResult,
} from '../types';
import { AdapterError } from '../types';

export interface SerperSearchConfig {
  apiKey: string;
}

/** Serper.dev 搜索 API 响应（第三方响应视为不可信输入，zod 校验后才进业务） */
const SerperResponseSchema = z.object({
  organic: z
    .array(
      z.object({
        title: z.string(),
        link: z.string().url(),
        snippet: z.string().optional(),
      }),
    )
    .default([]),
});

/** Real 实现：Serper.dev（https://google.serper.dev/search，Google 检索结果；仅填充数据源真实提供的字段，禁止虚构） */
export class SerperSearchAdapter implements CompanySearchAdapter {
  readonly name = 'CompanySearchAdapter' as const;

  constructor(private readonly config: SerperSearchConfig) {}

  async search(
    input: CompanySearchInput,
    ctx: AdapterContext,
  ): Promise<CompanySearchResult[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs ?? 15000);
    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY': this.config.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          q: buildQuery(input),
          num: Math.min(input.limit, 100), // Serper 单次最多 100 条
          page: input.page ?? 1,
          gl: input.country.toLowerCase(),
        }),
        signal: controller.signal,
      });
      if (res.status === 429) {
        throw new AdapterError('RATE_LIMITED', 'Serper rate limited');
      }
      if (!res.ok) {
        throw new AdapterError('UPSTREAM_ERROR', `Serper API HTTP ${res.status}`);
      }
      const parsed = SerperResponseSchema.parse(await res.json());
      const now = new Date();
      return parsed.organic.map((item) => ({
        // 搜索只返回标题/摘要/链接：mainProducts/email 等可选字段由 enriching:enrich 补齐，此处留空
        name: cleanTitle(item.title),
        website: item.link,
        country: input.country,
        description: item.snippet,
        source: 'serper' as const,
        searchedAt: now,
      }));
    } catch (err) {
      if (err instanceof AdapterError) throw err;
      if (err instanceof z.ZodError) {
        throw new AdapterError('BAD_RESPONSE', 'Serper response failed schema validation', err.flatten());
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AdapterError('TIMEOUT', 'Serper API timed out');
      }
      throw new AdapterError('UPSTREAM_ERROR', 'Serper API request failed', String(err));
    } finally {
      clearTimeout(timer);
    }
  }
}

function buildQuery(input: CompanySearchInput): string {
  // 买家侧意图：我们要找的是进口商/分销商（买我们货的人），不是供应商（同行/上游）。
  // 用 "importers <country>" 而非 "suppliers <country>"，后者会召回大量供应商目录页。
  const parts = [
    ...input.productKeywords,
    ...input.industryKeywords ?? [],
    ...input.companyTypes,
    `importers ${countryName(input.country)}`,
    'B2B',
  ];
  return parts.filter(Boolean).join(' ');
}

/** 标题里搜索引擎常附加「- 公司名 | Home」，只保留首段并去尾部符号 */
function cleanTitle(title: string): string {
  return title.split(/\s[|·–—-]\s/)[0]?.trim() || title.trim();
}

function countryName(code: string): string {
  const map: Record<string, string> = { US: 'USA', CA: 'Canada' };
  return map[code] ?? code;
}
