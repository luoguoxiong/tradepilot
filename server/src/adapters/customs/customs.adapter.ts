import { z } from 'zod';

import type { AdapterContext, DataSource } from '../types';
import { AdapterError } from '../types';

export interface CustomsQueryInput {
  company: { name: string; website?: string; country: string };
}

/** 单条进口记录（原始粒度，契约见 architecture.md §4.5） */
export interface CustomsRecordResult {
  companyName: string;
  importCountry: string;
  productDescription?: string;
  hsCode?: string;
  shipmentDate: Date;
  quantity?: string;
  supplierCountry?: string;
  supplierName?: string;
  source: DataSource;
}

export interface CustomsDataAdapter {
  readonly name: 'CustomsDataAdapter';
  /** 查询单条进口记录列表；无真实数据返回空数组，绝不伪造 */
  queryImportRecords(input: CustomsQueryInput, ctx: AdapterContext): Promise<CustomsRecordResult[]>;
}

/** 通用海关数据 API 响应（按 CUSTOMS_API_PROVIDER 适配的行结构；不可信输入需校验） */
const CustomsApiRowSchema = z.object({
  consignee_name: z.string().min(1),
  import_country: z.string().min(1),
  product_description: z.string().nullish(),
  hs_code: z.string().nullish(),
  shipment_date: z.string().min(1), // YYYY-MM-DD
  quantity: z.string().nullish(),
  supplier_country: z.string().nullish(),
  supplier_name: z.string().nullish(),
});

const CustomsApiResponseSchema = z.object({ records: z.array(CustomsApiRowSchema).default([]) });

export interface CustomsApiConfig {
  apiKey: string;
  baseUrl: string; // 如 https://api.customs-provider.com
  provider: string;
}

/**
 * Real 实现：通用海关数据 REST API。
 * 约定端点：GET {base}/imports/search?q=<company>&country=<importCountry>&api_key=<key>
 * 不同供应商字段差异通过 CUSTOMS_API_PROVIDER 环境变量预留适配位（MVP 按上述行结构）。
 */
export class GenericCustomsApiAdapter implements CustomsDataAdapter {
  readonly name = 'CustomsDataAdapter' as const;

  constructor(private readonly config: CustomsApiConfig) {}

  async queryImportRecords(input: CustomsQueryInput, ctx: AdapterContext): Promise<CustomsRecordResult[]> {
    const url = new URL(`${this.config.baseUrl.replace(/\/$/, '')}/imports/search`);
    url.searchParams.set('q', input.company.name);
    url.searchParams.set('country', input.company.country);
    url.searchParams.set('api_key', this.config.apiKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs ?? 15000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.status === 429) throw new AdapterError('RATE_LIMITED', 'Customs API rate limited');
      if (!res.ok) throw new AdapterError('UPSTREAM_ERROR', `Customs API HTTP ${res.status}`);

      const parsed = CustomsApiResponseSchema.parse(await res.json());
      return parsed.records.map((r) => ({
        companyName: r.consignee_name,
        importCountry: r.import_country,
        productDescription: r.product_description ?? undefined,
        hsCode: r.hs_code ?? undefined,
        shipmentDate: new Date(`${r.shipment_date}T00:00:00Z`),
        quantity: r.quantity ?? undefined,
        supplierCountry: r.supplier_country ?? undefined,
        supplierName: r.supplier_name ?? undefined,
        source: `customs:${this.config.provider}` as DataSource,
      }));
    } catch (err) {
      if (err instanceof AdapterError) throw err;
      if (err instanceof z.ZodError) {
        throw new AdapterError('BAD_RESPONSE', 'Customs API response failed schema validation', err.flatten());
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AdapterError('TIMEOUT', 'Customs API timed out');
      }
      throw new AdapterError('UPSTREAM_ERROR', 'Customs API request failed', String(err));
    } finally {
      clearTimeout(timer);
    }
  }
}
