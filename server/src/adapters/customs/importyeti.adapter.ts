import { z } from 'zod';

import type { AdapterContext, DataSource } from '../types';
import { AdapterError } from '../types';
import type { CustomsDataAdapter, CustomsQueryInput, CustomsRecordResult } from './customs.adapter';

export interface ImportYetiConfig {
  apiKey: string;
  /** 默认 https://data.importyeti.com，可覆盖用于测试/代理 */
  baseUrl: string;
}

/**
 * ImportYeti PowerQuery 响应（第三方响应视为不可信输入，zod 校验后才进业务）。
 * PowerQuery 系列端点把记录行嵌套在 data.data 下，匹配总数在 data.totalCount。
 */
const ImportYetiResponseSchema = z.object({
  data: z
    .object({
      data: z
        .array(
          z.object({
            company_name: z.string().min(1),
            arrival_date: z.string().min(1), // MM/DD/YYYY
            supplier_name: z.string().nullish(),
            supplier_country: z.string().nullish(),
            product_description: z.string().nullish(),
            hs_code: z.string().nullish(),
          }),
        )
        .default([]),
    })
    .default({ data: [] }),
});

/**
 * Real 实现：ImportYeti（美国海关 AMS 提单公开数据）。
 * 端点：GET {base}/v1.0/powerquery/us-import/bols（认证头 IYApiKey）。
 * 仅填充数据源真实提供的字段：ImportYeti 无数量字段，quantity 留空，禁止虚构。
 */
export class ImportYetiAdapter implements CustomsDataAdapter {
  readonly name = 'CustomsDataAdapter' as const;

  constructor(private readonly config: ImportYetiConfig) {}

  async queryImportRecords(
    input: CustomsQueryInput,
    ctx: AdapterContext,
  ): Promise<CustomsRecordResult[]> {
    const url = new URL(`${this.config.baseUrl.replace(/\/$/, '')}/v1.0/powerquery/us-import/bols`);
    url.searchParams.set('company', toSlug(input.company.name));
    url.searchParams.set('page', '1');
    url.searchParams.set('page_size', '10');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs ?? 15000);
    try {
      const res = await fetch(url, {
        headers: { IYApiKey: this.config.apiKey, Accept: 'application/json' },
        signal: controller.signal,
      });
      if (res.status === 401) {
        throw new AdapterError('UPSTREAM_ERROR', 'ImportYeti API key invalid (HTTP 401)');
      }
      if (res.status === 403) {
        throw new AdapterError('QUOTA_EXCEEDED', 'ImportYeti credits exhausted (HTTP 403)');
      }
      if (res.status === 429) {
        throw new AdapterError('RATE_LIMITED', 'ImportYeti rate limited');
      }
      if (!res.ok) {
        throw new AdapterError('UPSTREAM_ERROR', `ImportYeti API HTTP ${res.status}`);
      }
      const parsed = ImportYetiResponseSchema.parse(await res.json());
      return parsed.data.data.flatMap((row) => {
        const shipmentDate = parseArrivalDate(row.arrival_date);
        if (!shipmentDate) return []; // 日期异常的脏行跳过，不中断整页
        return [{
          companyName: row.company_name,
          importCountry: 'US', // us-import 数据集的进口国恒为美国
          productDescription: row.product_description ?? undefined,
          hsCode: row.hs_code ?? undefined,
          shipmentDate,
          supplierCountry: row.supplier_country ?? undefined,
          supplierName: row.supplier_name ?? undefined,
          source: 'customs:importyeti' as DataSource,
        }];
      });
    } catch (err) {
      if (err instanceof AdapterError) throw err;
      if (err instanceof z.ZodError) {
        throw new AdapterError('BAD_RESPONSE', 'ImportYeti response failed schema validation', err.flatten());
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AdapterError('TIMEOUT', 'ImportYeti API timed out');
      }
      throw new AdapterError('UPSTREAM_ERROR', 'ImportYeti API request failed', String(err));
    } finally {
      clearTimeout(timer);
    }
  }
}

/** ImportYeti 的 company 参数按 slug 标识公司（网站 URL 同格式：/company/ikea-supply） */
function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** arrival_date 为 MM/DD/YYYY，解析失败返回 null（脏行由调用方跳过） */
function parseArrivalDate(raw: string): Date | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  const date = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}
