import { Inject, Injectable } from '@nestjs/common';

import { getEnv } from '../config';
import { logger } from '../logger';
import { IntegrationsService } from '../integrations/integrations.service';
import { QuotaService } from './quota.service';
import { GoogleSearchAdapter, type GoogleSearchConfig } from './company-search/google-search.adapter';
import { MockCompanySearchAdapter } from './company-search/mock-company-search.adapter';
import { AdapterError, type AdapterContext, type CompanySearchAdapter } from './types';

/**
 * Adapter 工厂：integrations 表（用户级，优先）→ env（部署级默认）→ Mock（无 Key 降级，WARN）。
 * Real 实现外包一层配额计数。
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
