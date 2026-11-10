import type {
  AdapterContext,
  CompanySearchAdapter,
  CompanySearchInput,
  CompanySearchResult,
} from '../types';
import { hashInt } from '../dedupe.util';

/**
 * Mock 实现（无 Key 时自动降级）：数据恒标注 source:'demo'。
 * 确定性生成——同输入同输出，便于测试与演示；绝不伪装成真实数据。
 * 每 6 家混入 1 家供应商/工厂（i % 6 === 4），供演示「进口商判定 → 供应商过滤」链路。
 */
export class MockCompanySearchAdapter implements CompanySearchAdapter {
  readonly name = 'CompanySearchAdapter' as const;

  private static readonly NAME_PREFIX = [
    'Summit', 'Northline', 'Pacific Rim', 'Evergreen', 'Cascade', 'Sterling', 'Harborview',
    'Ironbridge', 'Bluewater', 'Redwood', 'Grandview', 'Lakeshore',
  ];
  private static readonly NAME_SUFFIX = [
    'Trading LLC', 'Imports Inc.', 'Distribution Co.', 'Sourcing Group', 'Retail Partners',
  ];
  private static readonly SUPPLIER_SUFFIX = ['Manufacturing Ltd.', 'Industrial Co.', 'Export Trading Co.'];
  private static readonly PRODUCT_ROLES = ['Importer', 'Distributor', 'Wholesaler', 'Retailer'];

  async search(
    input: CompanySearchInput,
    _ctx: AdapterContext,
  ): Promise<CompanySearchResult[]> {
    const keyword = input.productKeywords[0] ?? 'general merchandise';
    const keywordSlug = keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const count = Math.min(Math.max(input.limit, 1), 30);

    const results: CompanySearchResult[] = [];
    for (let i = 0; i < count; i++) {
      const seed = `${keywordSlug}:${input.country}:${i}`;
      const prefix = MockCompanySearchAdapter.NAME_PREFIX[hashInt(`${seed}:p`, MockCompanySearchAdapter.NAME_PREFIX.length)];
      const domain = `${keywordSlug}-${hashInt(seed, 9999) + 100}.com`;
      const isSupplier = i % 6 === 4;

      if (isSupplier) {
        // 供应商/工厂样例：名称与描述携带强供应商信号，管线会判定为 SUPPLIER 并过滤
        const suffix = MockCompanySearchAdapter.SUPPLIER_SUFFIX[hashInt(`${seed}:f`, MockCompanySearchAdapter.SUPPLIER_SUFFIX.length)];
        results.push({
          name: `${prefix} ${suffix}`,
          website: `https://www.${domain}`,
          country: input.country,
          description:
            `Manufacturer and exporter of ${keyword}. OEM/ODM factory with in-house production lines. ` +
            `[DEMO data]`,
          mainProducts: [keyword, `${keyword} accessories`],
          email: `sales@${domain}`,
          linkedinUrl: `https://www.linkedin.com/company/${domain.split('.')[0]}-demo`,
          source: 'demo',
          searchedAt: new Date(),
        });
        continue;
      }

      const suffix = MockCompanySearchAdapter.NAME_SUFFIX[hashInt(`${seed}:s`, MockCompanySearchAdapter.NAME_SUFFIX.length)];
      const role = input.companyTypes[hashInt(`${seed}:r`, input.companyTypes.length)] ??
        MockCompanySearchAdapter.PRODUCT_ROLES[hashInt(`${seed}:r`, MockCompanySearchAdapter.PRODUCT_ROLES.length)];

      results.push({
        name: `${prefix} ${suffix}`,
        website: `https://www.${domain}`,
        country: input.country,
        description:
          `${role} of ${keyword} and related products in ${input.country}. ` +
          `Sources from Asian manufacturers and serves B2B channels. [DEMO data]`,
        mainProducts: [keyword, `${keyword} accessories`],
        email: `purchasing@${domain}`,
        linkedinUrl: `https://www.linkedin.com/company/${domain.split('.')[0]}-demo`,
        source: 'demo',
        searchedAt: new Date(),
      });
    }
    return results;
  }
}
