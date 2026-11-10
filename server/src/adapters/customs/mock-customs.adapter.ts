import type { AdapterContext } from '../types';
import type { CustomsDataAdapter, CustomsQueryInput, CustomsRecordResult } from './customs.adapter';
import { hashInt } from '../dedupe.util';

const DESCRIPTIONS = [
  'Carbon fiber arch support insoles',
  'Footwear components and accessories',
  'Sports protective gear parts',
  'EVA foam padding sheets',
];
const HS_CODES = ['6406.99', '4012.90', '9506.99'];

/**
 * Mock 实现（无海关 API Key 降级）：确定性生成 0-3 条进口记录，恒标注 source:'demo'。
 * 部分公司生成 0 条 —— 演示“无进口记录 ≠ 无采购需求”的真实业务形态。
 */
export class MockCustomsAdapter implements CustomsDataAdapter {
  readonly name = 'CustomsDataAdapter' as const;

  async queryImportRecords(input: CustomsQueryInput, _ctx: AdapterContext): Promise<CustomsRecordResult[]> {
    const count = hashInt(`${input.company.name}:customs`, 4); // 0..3
    const records: CustomsRecordResult[] = [];
    for (let i = 0; i < count; i++) {
      const seed = `${input.company.name}:r${i}`;
      const month = 1 + hashInt(`${seed}:m`, 12);
      const day = 1 + hashInt(`${seed}:d`, 27);
      const year = 2025 + hashInt(`${seed}:y`, 2);
      records.push({
        companyName: input.company.name,
        importCountry: input.company.country,
        productDescription: DESCRIPTIONS[hashInt(`${seed}:p`, DESCRIPTIONS.length)],
        hsCode: HS_CODES[hashInt(`${seed}:h`, HS_CODES.length)],
        shipmentDate: new Date(Date.UTC(year, month - 1, day)),
        quantity: `${(1 + hashInt(`${seed}:q`, 12)) * 500} pairs`,
        supplierCountry: 'CN',
        supplierName: '[DEMO supplier]',
        source: 'demo',
      });
    }
    return records;
  }
}
