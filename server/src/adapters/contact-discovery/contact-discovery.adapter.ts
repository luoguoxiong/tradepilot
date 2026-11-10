import { z } from 'zod';

import type { AdapterContext, ContactCandidate, DataSource } from '../types';
import { AdapterError } from '../types';
import { domainFromWebsite } from '../dedupe.util';

export interface ContactDiscoveryInput {
  company: { id: string; name: string; website?: string; country: string };
  /** 目标职位：Purchasing/Procurement/Sourcing/Import Manager、CEO、Founder */
  titles: string[];
}

/** Apollo（混合人员搜索）响应校验：第三方响应视为不可信输入 */
const ApolloResponseSchema = z.object({
  people: z
    .array(
      z.object({
        name: z.string().min(1),
        title: z.string().default(''),
        email: z.string().email().nullish(),
        email_status: z.enum(['verified', 'unverified', 'unknown']).nullish(),
        linkedin_url: z.string().url().nullish(),
        country: z.string().nullish(),
      }),
    )
    .default([]),
});

export interface ApolloConfig {
  apiKey: string;
  baseUrl?: string;
}

/**
 * Real 实现：Apollo Organization/People Search（仅返回数据源真实提供的字段，不编造邮箱）。
 * 接口契约见 docs/architecture.md §4.4。
 */
export class ApolloContactDiscoveryAdapter {
  readonly name = 'ContactDiscoveryAdapter' as const;

  constructor(private readonly config: ApolloConfig) {}

  async discover(input: ContactDiscoveryInput, ctx: AdapterContext): Promise<ContactCandidate[]> {
    const domain = domainFromWebsite(input.company.website);
    const body: Record<string, unknown> = {
      api_key: this.config.apiKey,
      person_titles: input.titles.slice(0, 5),
      page: 1,
      per_page: 10,
      ...(domain ? { organization_domains: [domain] } : { q_organization_name: input.company.name }),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs ?? 15000);
    try {
      const res = await fetch(`${this.config.baseUrl ?? 'https://api.apollo.io/v1'}/mixed_people/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.status === 429) throw new AdapterError('RATE_LIMITED', 'Apollo rate limited');
      if (!res.ok) throw new AdapterError('UPSTREAM_ERROR', `Apollo HTTP ${res.status}`);

      const parsed = ApolloResponseSchema.parse(await res.json());
      return parsed.people.map((p) => ({
        name: p.name,
        title: p.title || 'Unknown',
        email: p.email ?? undefined, // Apollo 未返回邮箱时留空 → 前端引导手动补充，禁止编造
        linkedinUrl: p.linkedin_url ?? undefined,
        country: p.country ?? undefined,
        emailVerified: (p.email_status ?? 'unknown') as ContactCandidate['emailVerified'],
        source: 'apollo' as DataSource,
      }));
    } catch (err) {
      if (err instanceof AdapterError) throw err;
      if (err instanceof z.ZodError) {
        throw new AdapterError('BAD_RESPONSE', 'Apollo response failed schema validation', err.flatten());
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AdapterError('TIMEOUT', 'Apollo API timed out');
      }
      throw new AdapterError('UPSTREAM_ERROR', 'Apollo request failed', String(err));
    } finally {
      clearTimeout(timer);
    }
  }
}
