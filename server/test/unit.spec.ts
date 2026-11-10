/**
 * 阶段 8：关键纯函数单元测试（不依赖 DB/Redis/Nest，快跑）。
 * 覆盖：评分加权与分级 / 规则降级评分确定性 / 去重键 / CSV RFC4180 序列化解析 / Mock 适配器映射 / Serper 响应映射。
 */
import { AdapterError } from '../src/adapters/types';
import { buildDedupeKey, domainFromWebsite, hashInt } from '../src/adapters/dedupe.util';
import { MockCompanySearchAdapter } from '../src/adapters/company-search/mock-company-search.adapter';
import { MockContactDiscoveryAdapter } from '../src/adapters/contact-discovery/mock-contact-discovery.adapter';
import { MockCustomsAdapter } from '../src/adapters/customs/mock-customs.adapter';
import { SerperSearchAdapter } from '../src/adapters/company-search/serper-search.adapter';
import { csvEscape, parseCsv, rowsToObjects, toCsv } from '../src/crm/csv.util';
import { classifyBusinessRole } from '../src/companies/business-role';
import { computeWeightedScore, gradeOf, ruleBasedScoring } from '../src/ai/scoring/lead-scoring.service';
import type { ScoringOutput } from '../src/ai/scoring/lead-scoring.service';
import type { ScoringPromptInput } from '../src/ai/prompts/lead-scoring';

const ctx = { userId: 'u-test' };

// ---------- 1. 评分加权与分级（PRD §3.4 权重 30/25/25/10/10） ----------

describe('computeWeightedScore 加权计算', () => {
  const all = (v: number) => ({ product: v, business: v, customs: v, contact: v, region: v });

  it('全 0 → 0，全 100 → 100（权重和为 1）', () => {
    expect(computeWeightedScore(all(0))).toBe(0);
    expect(computeWeightedScore(all(100))).toBe(100);
  });

  it('按 30/25/25/10/10 加权并四舍五入', () => {
    // 80*0.3 + 60*0.25 + 70*0.25 + 40*0.1 + 50*0.1 = 24+15+17.5+4+5 = 65.5 → 66
    expect(computeWeightedScore({ product: 80, business: 60, customs: 70, contact: 40, region: 50 })).toBe(66);
    // 手工验算另一组：90*.3+50*.25+30*.25+100*.1+0*.1 = 27+12.5+7.5+10+0 = 57
    expect(computeWeightedScore({ product: 90, business: 50, customs: 30, contact: 100, region: 0 })).toBe(57);
  });

  it('权重集中验证：product 单独贡献 0.3 系数', () => {
    const base = { product: 0, business: 0, customs: 0, contact: 0, region: 0 };
    expect(computeWeightedScore({ ...base, product: 100 })).toBe(30);
    expect(computeWeightedScore({ ...base, business: 100 })).toBe(25);
    expect(computeWeightedScore({ ...base, customs: 100 })).toBe(25);
    expect(computeWeightedScore({ ...base, contact: 100 })).toBe(10);
    expect(computeWeightedScore({ ...base, region: 100 })).toBe(10);
  });
});

describe('gradeOf 分级边界', () => {
  it('A ≥ 80', () => {
    expect(gradeOf(80)).toBe('A');
    expect(gradeOf(100)).toBe('A');
  });
  it('B ∈ [60, 80)', () => {
    expect(gradeOf(79)).toBe('B');
    expect(gradeOf(60)).toBe('B');
  });
  it('C ∈ [40, 60)', () => {
    expect(gradeOf(59)).toBe('C');
    expect(gradeOf(40)).toBe('C');
  });
  it('D < 40', () => {
    expect(gradeOf(39)).toBe('D');
    expect(gradeOf(0)).toBe('D');
  });
});

// ---------- 2. 规则降级评分（确定性验收门：同输入同输出） ----------

function scoringInput(overrides?: Partial<ScoringPromptInput>): ScoringPromptInput {
  return {
    productName: 'Carbon Fiber Insoles',
    productKeywords: ['insoles', 'shoe accessories'],
    sellingPoints: ['OEM available'],
    company: {
      name: 'Summit Sports Gear LLC',
      country: 'US',
      description: 'Importer and distributor of sports gear. [DEMO data]',
      mainProducts: ['insoles'],
      source: 'demo',
    },
    contacts: [{ name: 'Sarah Miller', title: 'Purchasing Manager' }],
    customsRecords: [
      {
        productDescription: 'Carbon fiber arch support insoles',
        shipmentDate: new Date().toISOString().slice(0, 10),
        quantity: '3000 pairs',
        supplierCountry: 'CN',
      },
    ],
    ...overrides,
  };
}

describe('ruleBasedScoring 规则降级评分', () => {
  it('同输入同输出（评分稳定性验收门的确定性保证）', () => {
    const a = ruleBasedScoring(scoringInput());
    const b = ruleBasedScoring(scoringInput());
    expect(a).toEqual(b);
  });

  it('输出满足六项结构与五维子分约束', () => {
    const out = ruleBasedScoring(scoringInput());
    const keys: (keyof ScoringOutput)[] = [
      'subScores', 'matchReasons', 'purchaseNeeds', 'opportunities', 'suggestions', 'uncertaintyNotes',
    ];
    expect(Object.keys(out).sort()).toEqual(keys.sort());
    for (const v of Object.values(out.subScores)) expect(v).toBeGreaterThanOrEqual(0);
    for (const v of Object.values(out.subScores)) expect(v).toBeLessThanOrEqual(100);
    expect(out.matchReasons.length).toBeGreaterThanOrEqual(1);
  });

  it('关键词命中数提升 product 分：全命中 > 无命中', () => {
    const hit = ruleBasedScoring(scoringInput()).subScores.product;
    const miss = ruleBasedScoring(scoringInput({ productKeywords: ['quantum flux capacitors'] })).subScores.product;
    expect(hit).toBeGreaterThan(miss);
  });

  it('无海关记录 → customs 低分（25），并在 uncertaintyNotes 注明', () => {
    const out = ruleBasedScoring(scoringInput({ customsRecords: [] }));
    expect(out.subScores.customs).toBe(25);
    expect(out.uncertaintyNotes).toMatch(/no customs import records/i);
  });

  it('供应商角色 → business 低分（15）并建议跳过；进口商角色不受影响', () => {
    const supplier = ruleBasedScoring(
      scoringInput({ company: { ...scoringInput().company, businessRole: 'SUPPLIER' } }),
    );
    expect(supplier.subScores.business).toBe(15);
    expect(supplier.matchReasons.join(' ')).toMatch(/supplier/i);
    expect(supplier.suggestions).toMatch(/skip/i);

    const importer = ruleBasedScoring(
      scoringInput({ company: { ...scoringInput().company, businessRole: 'IMPORTER' } }),
    );
    expect(importer.subScores.business).toBe(78);
  });

  it('有近期海关记录 → customs 加成；DEMO 数据在 uncertaintyNotes 提示', () => {
    const out = ruleBasedScoring(scoringInput());
    expect(out.subScores.customs).toBeGreaterThanOrEqual(55);
    expect(out.uncertaintyNotes).toMatch(/DEMO/i);
  });

  it('无联系人 → contact 低分（30），suggestions 引导先挖掘联系人', () => {
    const out = ruleBasedScoring(scoringInput({ contacts: [] }));
    expect(out.subScores.contact).toBe(30);
    expect(out.suggestions).toMatch(/discover purchasing contacts first/i);
  });
});

// ---------- 3. 企业去重键 ----------

describe('domainFromWebsite 域名提取', () => {
  it('去协议、去 www、转小写', () => {
    expect(domainFromWebsite('https://www.Example.com/path?x=1')).toBe('example.com');
    expect(domainFromWebsite('http://WWW.Shop.io')).toBe('shop.io');
  });

  it('无协议前缀也可解析（搜索引擎结果常见裸域名）', () => {
    expect(domainFromWebsite('example.com/products')).toBe('example.com');
  });

  it('非法/空/无点主机返回 null', () => {
    expect(domainFromWebsite(null)).toBeNull();
    expect(domainFromWebsite(undefined)).toBeNull();
    expect(domainFromWebsite('')).toBeNull();
    expect(domainFromWebsite('not a url ??')).toBeNull();
    expect(domainFromWebsite('http://localhost:3000')).toBeNull();
  });
});

describe('buildDedupeKey 去重键', () => {
  it('域名优先：同名不同名、同站同键', () => {
    expect(buildDedupeKey('Foo Bar Inc.', 'https://www.acme.com/x')).toBe('acme.com');
    expect(buildDedupeKey('Completely Different LLC', 'acme.com')).toBe('acme.com');
  });

  it('无域名回退名称指纹：fp- 前缀 + SHA1 截断，稳定可复现', () => {
    const k1 = buildDedupeKey('Acme Trading Co.', null);
    const k2 = buildDedupeKey('Acme Trading Co.', undefined);
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^fp-[0-9a-f]{16}$/);
    // 规范化：大小写与多余空白不影响指纹
    expect(buildDedupeKey('  ACME   TRADING co. ')).toBe(k1);
    // 不同名称 → 不同指纹
    expect(buildDedupeKey('Other Company')).not.toBe(k1);
  });
});

describe('hashInt 确定性伪随机', () => {
  it('同输入同输出，且落在 [0, mod)', () => {
    expect(hashInt('seed-a', 10)).toBe(hashInt('seed-a', 10));
    for (let mod = 1; mod <= 30; mod++) {
      const v = hashInt('any-seed', mod);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(mod);
    }
  });

  it('mod=1 恒为 0', () => {
    expect(hashInt('x', 1)).toBe(0);
  });
});

// ---------- 4. CSV RFC4180 ----------

describe('CSV 序列化与解析（RFC 4180）', () => {
  it('csvEscape：含逗号/引号/换行的字段加引号，双引号转义；null/undefined → 空串', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
  });

  it('toCsv 带 UTF-8 BOM 与 CRLF 行尾（Excel 兼容）', () => {
    const csv = toCsv(['name', 'note'], [['Acme', 'ok']]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('\r\n');
    expect(csv).toContain('name,note');
  });

  it('引号内逗号/换行/双引号完整往返', () => {
    const headers = ['name', 'website', 'note'];
    const rows = [
      ['Summit "Sports", LLC', 'https://summitsports.com', 'Line1\nLine2'],
      ['Quoted "" Company', '', 'has, comma'],
    ];
    const roundtrip = rowsToObjects(toCsv(headers, rows));
    expect(roundtrip).toEqual([
      { name: 'Summit "Sports", LLC', website: 'https://summitsports.com', note: 'Line1\nLine2' },
      { name: 'Quoted "" Company', website: '', note: 'has, comma' },
    ]);
  });

  it('解析兼容 BOM、CRLF/CR/LF、尾随空行；列缺失补空串', () => {
    const csv = '\uFEFFa,b\r\nx,y\r\nz\r\n\r\n';
    expect(parseCsv(csv)).toEqual([['a', 'b'], ['x', 'y'], ['z']]);
    const objs = rowsToObjects('a,b\r\nx,y\r\nz');
    expect(objs).toEqual([{ a: 'x', b: 'y' }, { a: 'z', b: '' }]);
  });

  it('空输入 → 空数组', () => {
    expect(rowsToObjects('')).toEqual([]);
    expect(rowsToObjects('\r\n\r\n')).toEqual([]);
  });
});

// ---------- 5. Mock 适配器映射（确定性 + DEMO 标注） ----------

describe('MockCompanySearchAdapter 映射', () => {
  const adapter = new MockCompanySearchAdapter();

  it('同输入同输出（searchedAt 除外），source 恒 demo', async () => {
    const input = { productKeywords: ['yoga mats'], country: 'US', companyTypes: ['Importer'], limit: 5 };
    const [a, b] = await Promise.all([adapter.search(input, ctx), adapter.search(input, ctx)]);
    const strip = (rs: Awaited<ReturnType<typeof adapter.search>>) =>
      rs.map(({ searchedAt: _t, ...rest }) => rest);
    expect(strip(a)).toEqual(strip(b));
    expect(a.length).toBe(5);
    for (const r of a) {
      expect(r.source).toBe('demo');
      expect(r.description).toContain('[DEMO data]');
      expect(r.country).toBe('US');
      expect(r.mainProducts).toContain('yoga mats');
    }
  });

  it('limit 边界钳制：0 → 1，超过 30 → 30', async () => {
    const base = { productKeywords: ['k'], country: 'US', companyTypes: ['Importer'] };
    expect((await adapter.search({ ...base, limit: 0 }, ctx)).length).toBe(1);
    expect((await adapter.search({ ...base, limit: 999 }, ctx)).length).toBe(30);
  });

  it('不同关键词/国家产出不同结果集', async () => {
    const base = { productKeywords: ['k1'], country: 'US', companyTypes: ['Importer'], limit: 5 };
    const other = await adapter.search({ ...base, productKeywords: ['k2-xyz'], country: 'CA' }, ctx);
    expect(other[0].country).toBe('CA');
  });

  it('每 6 家混入 1 家供应商样例（确定性 i%6===4），供演示供应商过滤链路', async () => {
    const results = await adapter.search(
      { productKeywords: ['yoga mats'], country: 'US', companyTypes: ['Importer'], limit: 12 },
      ctx,
    );
    const suppliers = results.filter((r) => /Manufacturing Ltd\.|Industrial Co\.|Export Trading Co\./.test(r.name));
    expect(suppliers.length).toBe(2); // i=4, i=10
    for (const s of suppliers) {
      expect(s.description).toMatch(/Manufacturer and exporter|OEM\/ODM/);
      expect(s.email).toMatch(/^sales@/); // 供应商无采购邮箱
      expect(s.source).toBe('demo');
    }
    // 供应商样例同样确定性
    const again = await adapter.search(
      { productKeywords: ['yoga mats'], country: 'US', companyTypes: ['Importer'], limit: 12 },
      ctx,
    );
    expect(again.map((r) => r.name)).toEqual(results.map((r) => r.name));
  });
});

describe('MockContactDiscoveryAdapter 映射', () => {
  const adapter = new MockContactDiscoveryAdapter();
  const discover = (name: string) =>
    adapter.discover({ company: { id: 'c1', name, website: 'https://www.acme.com', country: 'US' }, titles: ['Purchasing Manager'] }, ctx);

  it('1-3 名联系人、emailVerified 合法枚举、source 恒 demo、邮箱落在公司域名', async () => {
    const people = await discover('Summit Sports Gear LLC');
    expect(people.length).toBeGreaterThanOrEqual(1);
    expect(people.length).toBeLessThanOrEqual(3);
    for (const p of people) {
      expect(p.source).toBe('demo');
      expect(['verified', 'unverified', 'unknown']).toContain(p.emailVerified);
      expect(p.email).toMatch(/@acme\.com$/);
      expect(p.title.length).toBeGreaterThan(0);
    }
  });

  it('确定性：同公司两次挖掘结果一致', async () => {
    expect(await discover('Evergreen Trading LLC')).toEqual(await discover('Evergreen Trading LLC'));
  });

  it('无网站时按名称派生域名，不产出空邮箱域名', async () => {
    const people = await adapter.discover(
      { company: { id: 'c2', name: 'No Website Co', country: 'US' }, titles: [] },
      ctx,
    );
    for (const p of people) expect(p.email).toMatch(/@nowebsiteco\.com$/);
  });
});

describe('MockCustomsAdapter 映射', () => {
  const adapter = new MockCustomsAdapter();

  it('0-3 条确定性记录，source 恒 demo，供应商国恒 CN', async () => {
    const input = { company: { name: 'Summit Sports Gear LLC', website: 'https://summitsports.com', country: 'US' } };
    const [a, b] = await Promise.all([
      adapter.queryImportRecords(input, ctx),
      adapter.queryImportRecords(input, ctx),
    ]);
    expect(a).toEqual(b);
    expect(a.length).toBeLessThanOrEqual(3);
    for (const r of a) {
      expect(r.source).toBe('demo');
      expect(r.supplierCountry).toBe('CN');
      expect(r.companyName).toBe('Summit Sports Gear LLC');
      expect(r.importCountry).toBe('US');
      expect(r.shipmentDate).toBeInstanceOf(Date);
    }
  });

  it('记录数由 hashInt 确定性决定（0..3），枚举探针覆盖 0 条与 >0 条两种形态', async () => {
    const names = Array.from({ length: 30 }, (_, i) => `Customs Count Probe ${i}`);
    const counts = await Promise.all(
      names.map((n) => adapter.queryImportRecords({ company: { name: n, country: 'US' } }, ctx)),
    );
    counts.forEach((rs, i) => {
      expect(rs.length).toBe(hashInt(`${names[i]}:customs`, 4));
    });
    expect(counts.some((rs) => rs.length === 0)).toBe(true);
    expect(counts.some((rs) => rs.length > 0)).toBe(true);
  });
});

// ---------- 6. 企业角色判定（进口商 vs 供应商） ----------

describe('classifyBusinessRole 角色判定', () => {
  it('供应商市场域名 → SUPPLIER（优先级最高）', () => {
    const r = classifyBusinessRole({
      name: 'Yoga Mats Factory',
      website: 'https://acme.en.alibaba.com/product/123.html',
      description: 'Buy yoga mats from verified suppliers',
    });
    expect(r.role).toBe('SUPPLIER');
    expect(r.signals[0]).toMatch(/marketplace domain/i);
  });

  it('有海关进口记录 → IMPORTER（无显式供应商信号时，真实采购行为是最强买家证据）', () => {
    const r = classifyBusinessRole({
      name: 'Summit Trading LLC',
      description: 'Wholesale company',
      importRecordCount: 3,
    });
    expect(r.role).toBe('IMPORTER');
    expect(r.signals.join(' ')).toMatch(/import record/i);
  });

  it('显式供应商信号优先于海关记录（工厂也可能出现在提单上，但不是我们的客户）', () => {
    const r = classifyBusinessRole({
      name: 'Ironbridge Manufacturing Ltd.',
      description: 'Manufacturer and exporter of goods',
      importRecordCount: 3,
    });
    expect(r.role).toBe('SUPPLIER');
    expect(r.signals.join(' ')).toMatch(/supplier/i);
  });

  it('名称即供应商（Manufacturing/Industrial）→ SUPPLIER', () => {
    expect(classifyBusinessRole({ name: 'Sterling Industrial Co.' }).role).toBe('SUPPLIER');
    expect(classifyBusinessRole({ name: 'Redwood Manufacturing Ltd.', description: 'We make shoes' }).role).toBe('SUPPLIER');
  });

  it('强供应商文本 → SUPPLIER（OEM/ODM/exporter/单数 manufacturer）', () => {
    expect(
      classifyBusinessRole({ name: 'Acme Goods', description: 'OEM & ODM services available' }).role,
    ).toBe('SUPPLIER');
    expect(
      classifyBusinessRole({ name: 'Acme Goods', description: 'Exporter of auto parts' }).role,
    ).toBe('SUPPLIER');
    expect(
      classifyBusinessRole({ name: 'Acme Goods', description: 'Manufacturer of yoga mats' }).role,
    ).toBe('SUPPLIER');
  });

  it('弱供应商文本优先于买家词："wholesale supplier" → SUPPLIER', () => {
    const r = classifyBusinessRole({ name: 'Acme Goods', description: 'Wholesale supplier of yoga mats' });
    expect(r.role).toBe('SUPPLIER');
  });

  it('买家文本 → IMPORTER（复数泛指 manufacturers 不误伤；Mock 描述样式可判定）', () => {
    const r = classifyBusinessRole({
      name: 'Summit Trading LLC',
      description: 'Importer of yoga mats and related products. Sources from Asian manufacturers.',
    });
    expect(r.role).toBe('IMPORTER');
    expect(r.signals.join(' ')).toMatch(/importer/i);
    expect(classifyBusinessRole({ name: 'Harborview Distribution Co.', description: '' }).role).toBe('IMPORTER');
    expect(classifyBusinessRole({ name: 'Bluewater Imports Inc.', description: '' }).role).toBe('IMPORTER');
    expect(classifyBusinessRole({ name: 'Evergreen Retail Partners', description: '' }).role).toBe('IMPORTER');
  });

  it('证据不足 → UNCLEAR，不猜测', () => {
    const r = classifyBusinessRole({ name: 'XYZ Holdings', description: null });
    expect(r.role).toBe('UNCLEAR');
    expect(r.signals.length).toBeGreaterThanOrEqual(1);
  });

  it('确定性：同输入同输出', () => {
    const input = { name: 'Acme Trading LLC', website: 'https://www.acme.com', description: 'Distributor of goods' };
    expect(classifyBusinessRole(input)).toEqual(classifyBusinessRole(input));
  });
});

// ---------- 7. Serper 适配器响应映射（fetch mock） ----------

describe('SerperSearchAdapter 响应映射', () => {
  const adapter = new SerperSearchAdapter({ apiKey: 'test-key' });
  const input = { productKeywords: ['insoles'], country: 'US', companyTypes: ['Importer'], limit: 10 };

  afterEach(() => jest.restoreAllMocks());

  function mockFetchOnce(payload: unknown): jest.SpyInstance {
    return jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    } as unknown as globalThis.Response);
  }

  it('organic 结果映射为 CompanySearchResult：title 清洗、website/link 映射、source=serper', async () => {
    mockFetchOnce({
      organic: [
        { title: 'Acme Trading LLC | Home', link: 'https://www.acmetrading.com/about', snippet: 'Importer of goods' },
        { title: 'B2B Suppliers - USA', link: 'https://directory.example.com/list', snippet: 'List page' },
      ],
    });
    const results = await adapter.search(input, ctx);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      name: 'Acme Trading LLC', // 「 | Home」尾段清洗
      website: 'https://www.acmetrading.com/about',
      description: 'Importer of goods',
      country: 'US',
      source: 'serper',
    });
    expect(results[1].name).toBe('B2B Suppliers');
  });

  it('请求体组装：关键词+公司类型+国家 gl 参数', async () => {
    const spy = mockFetchOnce({ organic: [] });
    await adapter.search(input, ctx);
    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.q).toContain('insoles');
    expect(body.q).toContain('Importer');
    // 买家侧意图：搜 importers（买家）而非 suppliers（会召回供应商目录页）
    expect(body.q).toContain('importers USA');
    expect(body.q).not.toContain('suppliers');
    expect(body.gl).toBe('us');
    expect(body.num).toBe(10);
  });

  it('429 → AdapterError RATE_LIMITED；响应缺字段走 zod default → 空数组', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 429 } as unknown as globalThis.Response);
    await expect(adapter.search(input, ctx)).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'RATE_LIMITED',
    });

    mockFetchOnce({}); // organic 缺失 → default([])
    await expect(adapter.search(input, ctx)).resolves.toEqual([]);
  });

  it('非法响应（organic 非数组）→ BAD_RESPONSE；AbortError → TIMEOUT', async () => {
    mockFetchOnce({ organic: 'not-an-array' });
    await expect(adapter.search(input, ctx)).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'BAD_RESPONSE',
    });

    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    jest.spyOn(global, 'fetch').mockRejectedValue(abortErr);
    await expect(adapter.search(input, ctx)).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'TIMEOUT',
    });
  });

  it('AdapterError 原样透传不被再包装', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new AdapterError('UPSTREAM_ERROR', 'boom'));
    await expect(adapter.search(input, ctx)).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });
});
