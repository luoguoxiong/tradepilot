import { Inject, Injectable } from '@nestjs/common';

import { getEnv } from '../config';
import { logger } from '../logger';
import { IntegrationsService } from '../integrations/integrations.service';
import { QuotaService } from './quota.service';
import { GoogleSearchAdapter } from './company-search/google-search.adapter';
import { MockCompanySearchAdapter } from './company-search/mock-company-search.adapter';
import { MockContactDiscoveryAdapter } from './contact-discovery/mock-contact-discovery.adapter';
import { ApolloContactDiscoveryAdapter } from './contact-discovery/contact-discovery.adapter';
import type { ContactDiscoveryInput } from './contact-discovery/contact-discovery.adapter';
import { MockCustomsAdapter } from './customs/mock-customs.adapter';
import { GenericCustomsApiAdapter } from './customs/customs.adapter';
import type { CustomsDataAdapter } from './customs/customs.adapter';
import { AdapterError, type AdapterContext, type CompanySearchAdapter } from './types';

export type { CustomsQueryInput } from './customs/customs.adapter';

/**
 * Adapter 工厂：integrations 表（用户级，优先）→ env（部署级默认）→ Mock（无 Key 降级，WARN）。
 * Real 实现统一外包配额计数（QuotaService）。
 */
@Injectable()
export class AdapterFactory {
  constructor(
    @Inject(IntegrationsService) private readonly integrations: IntegrationsService,
    @Inject(QuotaService) private readonly quota: QuotaService,
  ) {}

  async companySearch(ctx: AdapterContext): Promise<CompanySearchAdapter> {
    const dbConfig = await this.integrations.getConfig(ctx.userId, 'google').catch(() => null);
    const apiKey = dbConfig?.apiKey ?? (getEnv().GOOGLE_SEARCH_API_KEY || '');
    const cx = dbConfig?.extra?.cx ?? (getEnv().GOOGLE_SEARCH_CX || '');

    if (apiKey && cx) {
      if (!dbConfig) logger.warn('Google Search 使用 env 级 Key（用户级未配置）');
      return new QuotaWrappedCompanySearchAdapter(
        new GoogleSearchAdapter({ apiKey, cx }),
        this.quota,
        ctx.userId,
      );
    }

    logger.warn(
      { userId: ctx.userId },
      '无 Google Search API Key —— CompanySearchAdapter 降级为 Mock（DEMO 数据）',
    );
    return new MockCompanySearchAdapter();
  }

  /** 联系人挖掘：Apollo（integrations 'apollo'）→ Mock 降级 */
  async contactDiscovery(ctx: AdapterContext) {
    const dbConfig = await this.integrations.getConfig(ctx.userId, 'apollo').catch(() => null);
    const apiKey = dbConfig?.apiKey ?? (getEnv().APOLLO_API_KEY || '');
    if (apiKey) {
      const inner = new ApolloContactDiscoveryAdapter({ apiKey });
      return withQuota(inner, this.quota, ctx.userId, 'apollo');
    }
    logger.warn({ userId: ctx.userId }, '无 Apollo API Key —— ContactDiscoveryAdapter 降级为 Mock（DEMO 数据）');
    return new MockContactDiscoveryAdapter();
  }

  /** 海关数据：Customs API（integrations 'customs'）→ Mock 降级 */
  async customs(ctx: AdapterContext): Promise<CustomsDataAdapter> {
    const dbConfig = await this.integrations.getConfig(ctx.userId, 'customs').catch(() => null);
    const apiKey = dbConfig?.apiKey ?? (getEnv().CUSTOMS_API_KEY || '');
    const baseUrl = dbConfig?.extra?.baseUrl ?? (getEnv().CUSTOMS_API_URL || '');
    const provider = dbConfig?.extra?.provider ?? (getEnv().CUSTOMS_API_PROVIDER || 'generic');

    if (apiKey && baseUrl) {
      const inner = new GenericCustomsApiAdapter({ apiKey, baseUrl, provider });
      return withQuota(inner, this.quota, ctx.userId, 'customs');
    }
    logger.warn({ userId: ctx.userId }, '无海关 API Key —— CustomsDataAdapter 降级为 Mock（DEMO 数据）');
    return new MockCustomsAdapter();
  }
}

/** 为任意 { name } + 方法对象包一层配额计数，保留原 name 与方法签名 */
function withQuota<T extends object>(
  inner: T,
  quota: QuotaService,
  userId: string,
  provider: string,
  cost = 1,
): T {
  return new Proxy(inner, {
    async get(target, prop, receiver) {
      if (prop === 'name') return Reflect.get(target, prop, receiver);
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        await quota.consume(provider, userId, cost);
        return value.apply(target, args);
      };
    },
  }) as T;
}

class QuotaWrappedCompanySearchAdapter implements CompanySearchAdapter {
  readonly name = 'CompanySearchAdapter' as const;

  constructor(
    private readonly inner: CompanySearchAdapter,
    private readonly quota: QuotaService,
    private readonly userId: string,
  ) {}

  async search(input: Parameters<CompanySearchAdapter['search']>[0], ctx: AdapterContext) {
    const calls = Math.ceil(input.limit / 10); // Google 每页 10 条
    await this.quota.consume('google', this.userId, calls);
    return this.inner.search(input, ctx);
  }
}

/** 供上层捕获后降级处理的统一判断 */
export function isAdapterError(err: unknown): err is AdapterError {
  return err instanceof AdapterError;
}

export type { CustomsDataAdapter, ContactDiscoveryInput };
