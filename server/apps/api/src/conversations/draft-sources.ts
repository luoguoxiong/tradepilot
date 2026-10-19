import { and, eq, ilike, inArray, isNull, ne, or, type SQL } from 'drizzle-orm';

import { schema, type Tx } from '@tradepilot/db';

/**
 * 06 FR-10 草稿「结构化依据来源」（D9 恢复，06 §7 澄清 v0.3 / §4 行为红线）：
 *
 * P0 阶段 AI 草稿的唯一结构化来源是知识中心（11），产品中心（08）与报价规则（16）为 P1 ——
 * 本期恢复后，草稿的业务参数（SKU / MOQ / 交期 / 单价区间 / 规格 / 认证）允许来自：
 *   ① 知识检索结果（`knowledge_search`，11 知识中心）；
 *   ② 产品结构化数据（08 产品中心：`product` / `product_spec` / `product_price_tier`）；
 *   ③ 报价规则（16 设置：利润红线 / 默认币种 / Incoterms / 折让梯度 / 成本项）；
 *   ④ 产品资料（11 中由 08 自动归档的 `source='product'` 文档，D11）—— 与 ② 同源，一并作为可溯源依据。
 *
 * 无任何依据时仍按 §4 兜底：`grounded=false` + `missingInfo`，禁止编造（本模块只负责「给依据」，
 * 红线判定在草稿 prompt 与 LLM 输出契约里）。
 *
 * 匹配策略：从被回复消息（query）抽 token → 命中 product 的名称/SKU/描述/材质/分类，
 * 按命中 token 数排序取前 N 个产品（宁少勿多，只给最相关的），再补齐规格 / 阶梯价 / 产品资料。
 * 纯函数（`extractQueryTokens` / `buildStructuredSourceSections` / `isDraftGrounded`）与 DB 读取分离，便于单测。
 */

/** 单个产品的结构化事实（08 产品中心） */
export interface ProductFact {
  productId: string;
  sku: string;
  name: string;
  category: string | null;
  material: string | null;
  moq: number;
  moqUnit: string;
  leadTimeDays: number;
  currency: string;
  suggestedPrice: string | null;
  specs: { name: string; value: string; unit: string | null }[];
  priceTiers: { minQty: number; unitPrice: string }[];
  /** 该产品在 11 知识中心已归档的资料（`source='product'`），带实际引用到的 chunk（可溯源） */
  documents: { docId: string; docName: string; chunks: { chunkId: string; content: string }[] }[];
}

/** 报价规则事实（16 设置） */
export interface PricingRuleFact {
  profitFloorPct: string;
  defaultCurrency: string;
  defaultIncoterms: string;
  discountLadder: number[];
  costItems: string[];
  productCategories: string[];
}

export interface DraftSources {
  productFacts: ProductFact[];
  pricingRule: PricingRuleFact | null;
}

/** 与 06 §3.2 `citations` 同构（docName/chunkId 可空，06 §1.3） */
export interface DraftCitation {
  docId: string;
  docName?: string;
  chunkId?: string;
}

/** 通用词与寒暄词（不参与产品匹配，避免「price / 产品」这类词命中全部产品） */
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'you',
  'your',
  'our',
  'we',
  'are',
  'can',
  'could',
  'would',
  'should',
  'please',
  'thanks',
  'thank',
  'need',
  'needs',
  'want',
  'have',
  'has',
  'this',
  'that',
  'these',
  'those',
  'from',
  'about',
  'hi',
  'hello',
  'dear',
  'best',
  'regards',
  'kindly',
  'interest',
  'interested',
  'inquiry',
  'enquiry',
  'order',
  'orders',
  'send',
  'sent',
  'looking',
  'look',
  'new',
  'any',
  'more',
  'less',
  'than',
  'per',
  'item',
  'items',
  'product',
  'products',
  'sample',
  'samples',
  'price',
  'prices',
  'quote',
  'quotation',
  'moq',
  'lead',
  'time',
  'delivery',
  'day',
  'days',
  'week',
  'weeks',
  'pcs',
  'unit',
  'units',
  'email',
  'mail',
  'asap',
  'it',
  'is',
  'of',
  'to',
  'on',
  'in',
  'at',
  '我们',
  '你们',
  '请问',
  '您好',
  '你好',
  '需要',
  '产品',
  '价格',
  '报价',
  '交期',
  '数量',
  '谢谢',
  '是否',
  '可以',
  '能否',
  '麻烦',
  '关于',
  '这款',
  '一款',
  '下单',
  '采购',
  '邮件',
  '回复',
]);

/** 查询文本 → 匹配 token（英文/数字词 + 中文整段与 2 字滑窗；去重、去停用词、限量） */
export function extractQueryTokens(query: string, max = 16): string[] {
  const tokens: string[] = [];
  const push = (t: string): void => {
    const v = t.toLowerCase();
    if (v.length < 2 || STOPWORDS.has(v)) return;
    if (!tokens.includes(v)) tokens.push(v);
  };

  // 英文/数字：按非字母数字切分（`CF-001` → cf / 001，两者都能命中 SKU）
  for (const w of query.split(/[^\p{L}\p{N}]+/u)) {
    if (!w) continue;
    if (/^[0-9]+$/.test(w) && w.length < 2) continue;
    push(w);
  }

  // 中文（含日韩缩写等 CJK）：整段 + 2 字滑窗（无分词器时的可用近似）
  for (const run of query.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    push(run);
    for (let i = 0; i + 2 <= run.length; i += 1) {
      push(run.slice(i, i + 2));
    }
  }

  return tokens.slice(0, max);
}

/** LIKE 通配符转义（token 来自用户来信，含 % / _ 时不得当通配符） */
function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * 加载草稿结构化依据（query = 被回复消息正文）。
 * 只返回「确有命中」的产品（命中 token 数 ≥1，按命中数降序、名称升序确定性排序），最多 `maxProducts` 个。
 */
export async function loadDraftSources(
  tx: Tx,
  orgId: string,
  query: string,
  opts: { maxProducts?: number; chunksPerDoc?: number; maxChunkChars?: number } = {},
): Promise<DraftSources> {
  const maxProducts = opts.maxProducts ?? 3;
  const chunksPerDoc = opts.chunksPerDoc ?? 2;
  const maxChunkChars = opts.maxChunkChars ?? 400;
  const tokens = extractQueryTokens(query);

  const pricingRule = await loadPricingRule(tx, orgId);
  if (tokens.length === 0) {
    return { productFacts: [], pricingRule };
  }

  const matchers: SQL[] = [];
  for (const token of tokens) {
    const like = `%${escapeLike(token)}%`;
    matchers.push(
      or(
        ilike(schema.product.name, like),
        ilike(schema.product.sku, like),
        ilike(schema.product.description, like),
        ilike(schema.product.material, like),
        ilike(schema.product.category, like),
      )!,
    );
  }

  const candidates = await tx
    .select({
      id: schema.product.id,
      sku: schema.product.sku,
      name: schema.product.name,
      category: schema.product.category,
      material: schema.product.material,
      description: schema.product.description,
      moq: schema.product.moq,
      moqUnit: schema.product.moqUnit,
      leadTimeDays: schema.product.leadTimeDays,
      currency: schema.product.currency,
      suggestedPrice: schema.product.suggestedPrice,
    })
    .from(schema.product)
    .where(
      and(eq(schema.product.orgId, orgId), ne(schema.product.status, 'archived'), or(...matchers)),
    )
    .limit(50);

  const scored = candidates
    .map((p) => {
      const haystack = [p.name, p.sku, p.description ?? '', p.material ?? '', p.category ?? '']
        .join(' ')
        .toLowerCase();
      const score = tokens.filter((t) => haystack.includes(t)).length;
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => (b.score === a.score ? a.p.name.localeCompare(b.p.name) : b.score - a.score))
    .slice(0, maxProducts);

  if (scored.length === 0) {
    return { productFacts: [], pricingRule };
  }

  const productIds = scored.map((x) => x.p.id);
  const [specRows, tierRows, docRows] = await Promise.all([
    tx
      .select({
        productId: schema.productSpec.productId,
        name: schema.productSpec.name,
        value: schema.productSpec.value,
        unit: schema.productSpec.unit,
      })
      .from(schema.productSpec)
      .where(inArray(schema.productSpec.productId, productIds))
      .orderBy(schema.productSpec.seq),
    tx
      .select({
        productId: schema.productPriceTier.productId,
        minQty: schema.productPriceTier.minQty,
        unitPrice: schema.productPriceTier.unitPrice,
      })
      .from(schema.productPriceTier)
      .where(inArray(schema.productPriceTier.productId, productIds))
      .orderBy(schema.productPriceTier.minQty),
    tx
      .select({
        docId: schema.knowledgeDocument.id,
        docName: schema.knowledgeDocument.fileName,
        productId: schema.knowledgeDocument.productId,
      })
      .from(schema.knowledgeDocument)
      .where(
        and(
          eq(schema.knowledgeDocument.orgId, orgId),
          inArray(schema.knowledgeDocument.productId, productIds),
          eq(schema.knowledgeDocument.source, 'product'),
          eq(schema.knowledgeDocument.status, 'indexed'),
          isNull(schema.knowledgeDocument.deletedAt),
        ),
      ),
  ]);

  const docIds = docRows.map((d) => d.docId);
  const chunkRows =
    docIds.length > 0
      ? await tx
          .select({
            chunkId: schema.knowledgeChunk.id,
            documentId: schema.knowledgeChunk.documentId,
            content: schema.knowledgeChunk.content,
          })
          .from(schema.knowledgeChunk)
          .where(inArray(schema.knowledgeChunk.documentId, docIds))
          .orderBy(schema.knowledgeChunk.chunkIndex)
      : [];

  const productFacts: ProductFact[] = scored.map(({ p }) => ({
    productId: p.id,
    sku: p.sku,
    name: p.name,
    category: p.category,
    material: p.material,
    moq: p.moq,
    moqUnit: p.moqUnit,
    leadTimeDays: p.leadTimeDays,
    currency: p.currency,
    suggestedPrice: p.suggestedPrice,
    specs: specRows
      .filter((s) => s.productId === p.id)
      .map((s) => ({ name: s.name, value: s.value, unit: s.unit })),
    priceTiers: tierRows
      .filter((t) => t.productId === p.id)
      .map((t) => ({ minQty: t.minQty, unitPrice: t.unitPrice })),
    documents: docRows
      .filter((d) => d.productId === p.id)
      .map((d) => ({
        docId: d.docId,
        docName: d.docName,
        chunks: chunkRows
          .filter((c) => c.documentId === d.docId)
          .slice(0, chunksPerDoc)
          .map((c) => ({ chunkId: c.chunkId, content: c.content.slice(0, maxChunkChars) })),
      })),
  }));

  return { productFacts, pricingRule };
}

/** 报价规则（16 设置；未配置 → null，草稿 prompt 不注入该段） */
async function loadPricingRule(tx: Tx, orgId: string): Promise<PricingRuleFact | null> {
  const [row] = await tx
    .select({
      profitFloorPct: schema.pricingRuleSetting.profitFloorPct,
      defaultCurrency: schema.pricingRuleSetting.defaultCurrency,
      defaultIncoterms: schema.pricingRuleSetting.defaultIncoterms,
      discountLadder: schema.pricingRuleSetting.discountLadder,
      costItems: schema.pricingRuleSetting.costItems,
      productCategories: schema.pricingRuleSetting.productCategories,
    })
    .from(schema.pricingRuleSetting)
    .where(eq(schema.pricingRuleSetting.orgId, orgId))
    .limit(1);
  return row ?? null;
}

/** 产品结构化数据 + 报价规则 → prompt 段落（无依据时返回空数组） */
export function buildStructuredSourceSections(sources: DraftSources): string[] {
  const sections: string[] = [];

  if (sources.productFacts.length > 0) {
    const lines = sources.productFacts.map((p) => {
      const parts = [
        `SKU ${p.sku} ${p.name}`,
        `MOQ ${p.moq} ${p.moqUnit}`,
        `交期 ${p.leadTimeDays} 天`,
        `币种 ${p.currency}`,
      ];
      if (p.suggestedPrice) parts.push(`建议价 ${p.suggestedPrice}`);
      if (p.priceTiers.length > 0) {
        parts.push(`阶梯价 ${p.priceTiers.map((t) => `${t.minQty}+ → ${t.unitPrice}`).join('，')}`);
      }
      if (p.specs.length > 0) {
        parts.push(`规格 ${p.specs.map((s) => `${s.name} ${s.value}${s.unit ?? ''}`).join('，')}`);
      }
      if (p.material) parts.push(`材质 ${p.material}`);
      return `- ${parts.join('；')}`;
    });
    sections.push(`【产品结构化数据（08 产品中心）】\n${lines.join('\n')}`);
  }

  const rule = sources.pricingRule;
  if (rule) {
    sections.push(
      `【报价规则（16 设置）】\n- 利润红线 ${rule.profitFloorPct}%；默认币种 ${rule.defaultCurrency}；默认 Incoterms ${rule.defaultIncoterms}；折让梯度 ${rule.discountLadder.join('/')}；成本项 ${rule.costItems.join('/')}`,
    );
  }

  const docLines: string[] = [];
  for (const fact of sources.productFacts) {
    for (const doc of fact.documents) {
      for (const chunk of doc.chunks) {
        docLines.push(`- ${doc.docName}: ${chunk.content}`);
      }
    }
  }
  if (docLines.length > 0) {
    sections.push(`【产品资料（11 知识中心·08 自动归档）】\n${docLines.join('\n')}`);
  }

  return sections;
}

/** 依据型 citations：知识检索命中 + 产品资料实际引用到的 chunk（产品无资料 chunk 则不出引用） */
export function composeDraftCitations(
  knowledge: { docId: string; docName?: string; chunkId?: string }[],
  sources: DraftSources,
): DraftCitation[] {
  const citations: DraftCitation[] = knowledge.map((c) => ({
    docId: c.docId,
    ...(c.docName !== undefined ? { docName: c.docName } : {}),
    ...(c.chunkId !== undefined ? { chunkId: c.chunkId } : {}),
  }));
  for (const fact of sources.productFacts) {
    for (const doc of fact.documents) {
      const [first] = doc.chunks;
      if (!first) continue;
      citations.push({ docId: doc.docId, docName: doc.docName, chunkId: first.chunkId });
    }
  }
  return citations;
}

/**
 * 草稿是否有依据（06 §4 红线 / FR-10）：
 * 知识检索命中或产品结构化数据命中任一即可 → 否则 `missingKnowledge`（前端提示补充资料）。
 */
export function isDraftGrounded(input: {
  citationCount: number;
  productFactCount: number;
}): boolean {
  return input.citationCount > 0 || input.productFactCount > 0;
}

/** 草稿系统提示词（FR-10：参数只允许来自知识检索结果 / 产品结构化数据 / 报价规则） */
export const DRAFT_SYSTEM_PROMPT =
  '你是外贸销售写手。生成一封回复邮件。红线：业务参数（价格/MOQ/交期/规格/认证）只允许引用【知识检索结果】、【产品结构化数据（08 产品中心）】、【报价规则（16 设置）】或【产品资料】中的结构化事实；无依据参数时置 grounded=false 并列出 missingInfo，禁止编造。语言跟随 detectedLanguage。';
