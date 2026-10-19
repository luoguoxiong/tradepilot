import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

import { createId } from '@tradepilot/core';
import { closeDb, createDb, schema, withOrg, type Db } from '@tradepilot/db';

import {
  buildStructuredSourceSections,
  composeDraftCitations,
  DRAFT_SYSTEM_PROMPT,
  extractQueryTokens,
  isDraftGrounded,
  loadDraftSources,
  type DraftSources,
} from '../src/conversations/draft-sources.js';

/**
 * 06 FR-10（D9 恢复）· 草稿结构化依据来源集成用例：
 * - 产品中心（08）：按被回复消息抽 token 命中产品 → MOQ / 交期 / 阶梯价 / 规格；
 * - 报价规则（16）：利润红线 / 默认币种 / Incoterms / 折让梯度 / 成本项；
 * - 产品资料（11·08 自动归档，D11）：`source='product'` 文档 + chunk 一并作为可溯源依据；
 * - 边界：归档产品不参与、无命中产品时只回报价规则、`missingKnowledge` 判定（两者皆无才提示补充）。
 *
 * 纯函数（token 抽取 / prompt 段落 / 依据判定 / citations 组装）在本档内直接单测，
 * 不依赖 LLM provider（草稿端的 LLM 往返见 m5-e1）。
 *
 * 前置：docker compose up（PG 5432）+ `pnpm --filter @tradepilot/db migrate`。
 */

process.env.JWT_SECRET ||= 'it_only_test_secret_0123456789abcdef0123456789abcdef';
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_URL ||= 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';

const SUPER_URL = 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';
const APP_URL = 'postgresql://tradepilot_app:changeme_app@localhost:5432/tradepilot';

let superDb: Db;
let appDb: Db;

const ORG = createId('org');
const ADMIN = createId('usr');
const P_INSOLE = createId('prd');
const P_BELT = createId('prd');
const P_ARCHIVED = createId('prd');
const DOC = createId('kdoc');
const CHUNK_1 = createId('kchk');
const CHUNK_2 = createId('kchk');

const QUERY = 'Hi, we need carbon fiber insoles, please advise MOQ 500 and lead time.';

/** 查询一次草稿依据（走 org 事务，等价服务内 withOrg(appDb) 路径） */
async function sourcesOf(query: string): Promise<DraftSources> {
  return withOrg(appDb, ORG, (tx) => loadDraftSources(tx, ORG, query));
}

beforeAll(async () => {
  superDb = createDb(SUPER_URL, { max: 2 });
  appDb = createDb(APP_URL, { max: 5 });

  await superDb.transaction(async (tx) => {
    await tx
      .insert(schema.org)
      .values({ id: ORG, name: 'M5-FR10 草稿依据租户', timezone: 'Asia/Shanghai' });
    await tx.insert(schema.userAccount).values({
      id: ADMIN,
      orgId: ORG,
      email: `m5fr10-${ORG.slice(-6)}@test.com`,
      passwordHash: 'x',
      name: '依据管理员',
      role: 'admin',
      status: 'active',
    });

    // 命中产品（08 产品中心：结构化参数 + 阶梯价 + 规格）
    await tx.insert(schema.product).values({
      id: P_INSOLE,
      orgId: ORG,
      sku: 'CF-001',
      name: 'Carbon Fiber Insoles',
      category: '鞋材',
      moq: 500,
      moqUnit: 'pcs',
      leadTimeDays: 30,
      material: 'carbon fiber',
      description: '碳纤维鞋垫，支持定制厚度，CE 认证',
      costPrice: '8.00',
      currency: 'USD',
      suggestedPrice: '12.50',
      status: 'active',
      createdBy: ADMIN,
    });
    await tx.insert(schema.productSpec).values({
      id: createId('pspec'),
      productId: P_INSOLE,
      seq: 1,
      name: '厚度',
      value: '3',
      unit: 'mm',
    });
    await tx.insert(schema.productPriceTier).values([
      { id: createId('ptier'), productId: P_INSOLE, minQty: 500, unitPrice: '12.5000' },
      { id: createId('ptier'), productId: P_INSOLE, minQty: 1000, unitPrice: '11.8000' },
    ]);
    // 同 org 不相关产品（不得被命中）
    await tx.insert(schema.product).values({
      id: P_BELT,
      orgId: ORG,
      sku: 'LB-100',
      name: 'Leather Belt',
      category: '配饰',
      moq: 100,
      moqUnit: 'pcs',
      leadTimeDays: 15,
      material: 'leather',
      costPrice: '3.00',
      currency: 'USD',
      status: 'active',
      createdBy: ADMIN,
    });
    // 已归档产品：即便命中文本也不得作为依据
    await tx.insert(schema.product).values({
      id: P_ARCHIVED,
      orgId: ORG,
      sku: 'CF-OLD',
      name: 'Carbon fiber insoles (旧款)',
      category: '鞋材',
      moq: 300,
      moqUnit: 'pcs',
      leadTimeDays: 45,
      costPrice: '9.00',
      currency: 'USD',
      status: 'archived',
      createdBy: ADMIN,
    });

    // 08 自动归档到 11 的产品资料（D11）：source='product' + productId
    await tx.insert(schema.knowledgeDocument).values({
      id: DOC,
      orgId: ORG,
      fileName: 'CF-001 产品目录.pdf',
      category: 'product',
      fileType: 'pdf',
      fileUrl: 'https://files.local/cf-001.pdf',
      status: 'indexed',
      source: 'product',
      productId: P_INSOLE,
      uploadedBy: ADMIN,
      indexedAt: new Date(),
    });
    await tx.insert(schema.knowledgeChunk).values([
      {
        id: CHUNK_1,
        orgId: ORG,
        documentId: DOC,
        chunkIndex: 0,
        content: 'CF-001 碳纤维鞋垫通过 CE 认证，MOQ 500 pcs，交期 30 天。',
      },
      {
        id: CHUNK_2,
        orgId: ORG,
        documentId: DOC,
        chunkIndex: 1,
        content: '包装：50 pcs/箱，支持 OEM 定制。',
      },
    ]);

    // 16 报价规则
    await tx.insert(schema.pricingRuleSetting).values({
      id: createId('prs'),
      orgId: ORG,
      productCategories: ['鞋材', '配饰'],
      costItems: ['purchase', 'freight', 'insurance', 'tax', 'fx'],
      profitFloorPct: '18.00',
      discountLadder: [0, 5, 8],
      defaultIncoterms: 'FOB',
      defaultCurrency: 'USD',
      exchangeRateSource: 'manual',
      updatedBy: ADMIN,
    });
  });
});

afterAll(async () => {
  const productIds = [P_INSOLE, P_BELT, P_ARCHIVED];
  await superDb.transaction(async (tx) => {
    await tx.delete(schema.knowledgeChunk).where(eq(schema.knowledgeChunk.orgId, ORG));
    await tx.delete(schema.knowledgeDocument).where(eq(schema.knowledgeDocument.orgId, ORG));
    // 规格 / 阶梯价无 org_id 列（随 product 归属），按本档产品 id 清理
    await tx
      .delete(schema.productPriceTier)
      .where(inArray(schema.productPriceTier.productId, productIds));
    await tx.delete(schema.productSpec).where(inArray(schema.productSpec.productId, productIds));
    await tx.delete(schema.product).where(eq(schema.product.orgId, ORG));
    await tx.delete(schema.pricingRuleSetting).where(eq(schema.pricingRuleSetting.orgId, ORG));
    await tx.delete(schema.userAccount).where(eq(schema.userAccount.orgId, ORG));
    await tx.delete(schema.org).where(eq(schema.org.id, ORG));
  });
  await closeDb(appDb);
  await closeDb(superDb);
});

describe('FR-10 产品结构化数据（08）作为草稿依据', () => {
  it('按被回复消息命中产品：MOQ / 交期 / 币种 / 建议价 / 阶梯价 / 规格 齐全，且不误命中无关产品', async () => {
    const sources = await sourcesOf(QUERY);
    expect(sources.productFacts.length).toBe(1);
    const fact = sources.productFacts[0]!;
    expect(fact.productId).toBe(P_INSOLE);
    expect(fact.sku).toBe('CF-001');
    expect(fact.moq).toBe(500);
    expect(fact.moqUnit).toBe('pcs');
    expect(fact.leadTimeDays).toBe(30);
    expect(fact.currency).toBe('USD');
    expect(Number(fact.suggestedPrice)).toBe(12.5);
    expect(fact.priceTiers.map((t) => [t.minQty, Number(t.unitPrice)])).toEqual([
      [500, 12.5],
      [1000, 11.8],
    ]);
    expect(fact.specs).toEqual([{ name: '厚度', value: '3', unit: 'mm' }]);
    // 无关产品（皮革腰带）不进依据
    expect(sources.productFacts.some((f) => f.productId === P_BELT)).toBe(false);
  });

  it('已归档产品不作为依据（status=archived 排除）', async () => {
    const sources = await sourcesOf(QUERY);
    expect(sources.productFacts.some((f) => f.productId === P_ARCHIVED)).toBe(false);
  });

  it('产品资料（11·source=product）随依据返回：文档名 + 实际引用 chunk（可溯源）', async () => {
    const sources = await sourcesOf(QUERY);
    const docs = sources.productFacts[0]!.documents;
    expect(docs.length).toBe(1);
    expect(docs[0]!.docName).toBe('CF-001 产品目录.pdf');
    expect(docs[0]!.chunks.map((c) => c.chunkId)).toEqual([CHUNK_1, CHUNK_2]);
    expect(docs[0]!.chunks[0]!.content).toContain('CE 认证');
  });

  it('无产品命中时只回报价规则（产品依据为空，不报错）', async () => {
    const sources = await sourcesOf('Do you sell garden tools?');
    expect(sources.productFacts).toEqual([]);
    expect(sources.pricingRule).not.toBeNull();
  });
});

describe('FR-10 报价规则（16）作为草稿依据', () => {
  it('利润红线 / 默认币种 / Incoterms / 折让梯度 / 成本项', async () => {
    const { pricingRule } = await sourcesOf(QUERY);
    expect(pricingRule).not.toBeNull();
    expect(Number(pricingRule!.profitFloorPct)).toBe(18);
    expect(pricingRule!.defaultCurrency).toBe('USD');
    expect(pricingRule!.defaultIncoterms).toBe('FOB');
    expect(pricingRule!.discountLadder).toEqual([0, 5, 8]);
    expect(pricingRule!.costItems).toContain('freight');
  });
});

describe('FR-10 纯函数（token / prompt 段落 / 依据判定 / citations）', () => {
  it('extractQueryTokens：英文去停用词与寒暄词，保留产品标识词', () => {
    expect(extractQueryTokens('Hi, we need carbon fiber insoles! MOQ 500')).toEqual([
      'carbon',
      'fiber',
      'insoles',
      '500',
    ]);
    // SKU 形态（CF-001 → cf / 001）便于命中产品
    expect(extractQueryTokens('price for CF-001?')).toEqual(['cf', '001']);
  });

  it('extractQueryTokens：中文整段 + 2 字滑窗（无分词器近似）', () => {
    const tokens = extractQueryTokens('碳纤维鞋垫的报价');
    expect(tokens).toContain('碳纤维鞋垫的报价');
    expect(tokens).toContain('鞋垫');
    // 通用词「报价」不进 token
    expect(tokens).not.toContain('报价');
  });

  it('buildStructuredSourceSections：注入产品 / 报价规则 / 产品资料三段', async () => {
    const sources = await sourcesOf(QUERY);
    const sections = buildStructuredSourceSections(sources);
    expect(sections.length).toBe(3);
    const text = sections.join('\n');
    expect(text).toContain('【产品结构化数据（08 产品中心）】');
    expect(text).toContain('MOQ 500 pcs');
    expect(text).toContain('交期 30 天');
    expect(text).toContain('阶梯价 500+ → 12.5000');
    expect(text).toContain('【报价规则（16 设置）】');
    expect(text).toContain('利润红线 18.00%');
    expect(text).toContain('【产品资料（11 知识中心·08 自动归档）】');
    expect(text).toContain('CF-001 产品目录.pdf');

    // 无依据 → 不注入任何段落
    expect(buildStructuredSourceSections({ productFacts: [], pricingRule: null })).toEqual([]);
  });

  it('composeDraftCitations：知识检索命中 + 产品资料首 chunk（无 chunk 的产品不出引用）', async () => {
    const sources = await sourcesOf(QUERY);
    const citations = composeDraftCitations(
      [{ docId: 'kdoc_kb', docName: 'MOQ 政策.pdf', chunkId: 'kchk_kb' }],
      sources,
    );
    expect(citations).toEqual([
      { docId: 'kdoc_kb', docName: 'MOQ 政策.pdf', chunkId: 'kchk_kb' },
      { docId: DOC, docName: 'CF-001 产品目录.pdf', chunkId: CHUNK_1 },
    ]);
    const noDoc: DraftSources = {
      ...sources,
      productFacts: [{ ...sources.productFacts[0]!, documents: [] }],
    };
    expect(composeDraftCitations([], noDoc)).toEqual([]);
  });

  it('isDraftGrounded：知识命中或产品依据任一即「有依据」（06 §4 红线缺省提示补充资料）', () => {
    expect(isDraftGrounded({ citationCount: 1, productFactCount: 0 })).toBe(true);
    expect(isDraftGrounded({ citationCount: 0, productFactCount: 1 })).toBe(true);
    expect(isDraftGrounded({ citationCount: 0, productFactCount: 0 })).toBe(false);
  });

  it('草稿系统提示词放开结构化来源（FR-10）并保留编造红线', () => {
    expect(DRAFT_SYSTEM_PROMPT).toContain('产品结构化数据（08 产品中心）');
    expect(DRAFT_SYSTEM_PROMPT).toContain('报价规则（16 设置）');
    expect(DRAFT_SYSTEM_PROMPT).toContain('禁止编造');
  });
});
