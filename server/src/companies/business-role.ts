/**
 * 企业角色判定（进口商 vs 供应商）——确定性纯函数，同输入同输出。
 * 用途：Lead Discovery 管线中过滤掉供应商/工厂（他们不是我们的客户，而是同行/上游），
 *      只保留进口商/分销商等真实买家进入评分与开发信环节。
 * 证据优先级：供应商市场域名 > 企业名称 > 强供应商文本 > 海关进口记录 > 弱供应商文本 > 买家文本。
 * 说明：显式供应商信号（市场域名/名称/第一人称强文本）优先于海关记录——
 *      工厂/出口商也可能出现在提单上，但它们依然不是我们的客户。
 */

export type BusinessRole = 'IMPORTER' | 'SUPPLIER' | 'UNCLEAR';

export interface RoleClassificationInput {
  name: string;
  website?: string | null;
  description?: string | null;
  mainProducts?: string[];
  /** 已落库的海关进口记录数（该企业作为买家的提单数）——真实采购行为是最强买家证据 */
  importRecordCount?: number;
}

export interface RoleClassification {
  role: BusinessRole;
  /** 命中的判定信号（英文短句，供前端展示与解释） */
  signals: string[];
}

/** B2B 供应商市场/黄页域名：落在这些站点上的条目基本是供应商目录页，不是买家官网 */
const SUPPLIER_MARKET_DOMAINS = [
  'alibaba.com',
  'made-in-china.com',
  'globalsources.com',
  'dhgate.com',
  '1688.com',
  'hktdc.com',
  'tradekey.com',
  'ec21.com',
  'exportimes.com',
  'aliexpress.com',
  'china.cn',
  'b2bcenter.com',
];

/** 企业名称中的供应商模式（Manufacturing Ltd / Industrial Co 等） */
const SUPPLIER_NAME_RE =
  /\bmanufacturing\b|\bindustrial\b|\bfactory\b|\bforge\b|\bexport(s|er|ing)? (co|company|trading)\b/i;

/** 强供应商文本：第一人称/直接表述（复数泛指如 "sources from manufacturers" 不算） */
const SUPPLIER_TEXT_RE =
  /\bmanufacturer\b|\bfactories?\b|\bmanufacturing (plant|facility|capabilities|base)\b|\bOEM\b|\bODM\b|\bexporter\b|\bexport(s)? to\b|\bwe manufacture\b|\bmanufacturer of\b/i;

/** 弱供应商文本：自称 supplier/supply（优先于买家词，"wholesale supplier" 应判供应商） */
const SUPPLIER_WEAK_RE = /\bsuppliers?\b|\bwe supply\b|\bsupplying\b|\bwholesale supplier\b/i;

/** 买家（进口商/分销商）文本 */
const BUYER_TEXT_RE =
  /\bimporter\b|\bimporting\b|\bimport(s|ed)?\b|\bimport & distribution\b|\bdistributor\b|\bdistribution\b|\bwholesaler\b|\bwholesale\b|\bretail(?:ers?)?\b|\bbuyers?\b|\bpurchasing\b|\bprocurement\b|\bprivate label\b|\bsourcing (company|group|agent|office|partner)s?\b/i;

function domainOf(website?: string | null): string {
  if (!website) return '';
  try {
    const host = new URL(website.includes('://') ? website : `https://${website}`).hostname;
    return host.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isMarketDomain(domain: string): string | null {
  if (!domain) return null;
  const hit = SUPPLIER_MARKET_DOMAINS.find((d) => domain === d || domain.endsWith(`.${d}`));
  return hit ?? null;
}

function matches(re: RegExp, texts: (string | null | undefined)[]): RegExpMatchArray[] {
  const out: RegExpMatchArray[] = [];
  for (const text of texts) {
    if (!text) continue;
    const m = text.match(re);
    if (m) out.push(m);
  }
  return out;
}

/**
 * 判定企业角色。规则按证据强度顺序短路，返回第一个确定的结论；证据不足时 UNCLEAR（不猜测）。
 * 注意：本函数只做证据判定，不做网络请求；海关记录数由调用方（CompaniesService.classify）聚合提供。
 */
export function classifyBusinessRole(input: RoleClassificationInput): RoleClassification {
  const signals: string[] = [];
  const domain = domainOf(input.website);
  const desc = input.description ?? '';
  const products = (input.mainProducts ?? []).join(', ');

  // 1. 供应商市场/黄页域名 → SUPPLIER（搜索结果落在目录页）
  const market = isMarketDomain(domain);
  if (market) {
    signals.push(`supplier marketplace domain: ${domain}`);
    return { role: 'SUPPLIER', signals };
  }

  const textHits = (re: RegExp) => matches(re, [input.name, desc, products]);

  // 2. 企业名称即供应商（Acme Manufacturing Ltd / Sterling Industrial Co）
  const nameSupplier = input.name.match(SUPPLIER_NAME_RE);
  if (nameSupplier) {
    signals.push(`supplier-type company name: "${nameSupplier[0]}"`);
    return { role: 'SUPPLIER', signals };
  }

  // 3. 强供应商文本（manufacturer/factory/OEM/ODM/exporter）
  for (const m of textHits(SUPPLIER_TEXT_RE)) {
    signals.push(`supplier signal: "${m[0]}"`);
  }
  if (signals.length > 0) {
    return { role: 'SUPPLIER', signals };
  }

  // 4. 有海关进口记录 → IMPORTER（该企业作为买家真实采购过的最强证据）
  if ((input.importRecordCount ?? 0) > 0) {
    signals.push(`has ${input.importRecordCount} customs import record(s)`);
    return { role: 'IMPORTER', signals };
  }

  // 5. 弱供应商文本（自称 supplier）——优先于买家词，避免 "wholesale supplier" 误判为买家
  for (const m of textHits(SUPPLIER_WEAK_RE)) {
    signals.push(`supplier signal: "${m[0]}"`);
  }
  if (signals.length > 0) {
    return { role: 'SUPPLIER', signals };
  }

  // 6. 买家文本（importer/distributor/wholesaler/retailer…）
  for (const m of textHits(BUYER_TEXT_RE)) {
    signals.push(`buyer signal: "${m[0]}"`);
  }
  if (signals.length > 0) {
    return { role: 'IMPORTER', signals };
  }

  // 7. 证据不足，不猜测
  signals.push('no importer/supplier evidence in profile');
  return { role: 'UNCLEAR', signals };
}
