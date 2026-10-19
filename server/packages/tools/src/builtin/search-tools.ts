/**
 * 外部信息类工具（05 §3）：web_search / site_crawl / find_contact / lookup_contact / lead_scoring。
 * M4-1：lead_hunting 图真实链路落地——搜索轮次换词、联系人发现与公开渠道查找、
 * 决策影响力 90/75/40 档确定性映射（04 需求 §3.2）。
 * M4-6：web_search/site_crawl 接供应商适配器（06 §3，@tradepilot/integrations getSearchProvider；
 * worker 启动时 setSearchProviderFactory 按 org 注入「AI 模型配置」选用的供应商，未配置明确报错）
 * + org 级日额度令牌桶。
 * find_contact/lookup_contact：数据源 = 同 §3 注入的搜索供应商（公开渠道，06 §3.1）——
 * ①人物检索返回的标题/摘要；②**官网联系页正文**（首页 → 首页 contact/about/team 链接 →
 * 兜底路径，复用 crawlSite 的 robots/限速/UA 基元）。姓名/职衔/邮箱一律取自真实返回文本，
 * 抽取不到即跳过或留空，禁止合成姓名、禁止猜邮箱、禁止跨公司绑定（08 §6 / 08 §7）。
 */
import { z } from 'zod';
import { BizException, ErrorCode } from '@tradepilot/core';
import { TASK_LOG_TYPE, type CompanyLead, type LeadContact } from '@tradepilot/shared';
import { getSearchProvider, type FetchedPage, type SearchProvider } from '@tradepilot/integrations';
import type { ToolContext, ToolDefinition } from '../registry.js';
import { writeToolLog } from '../registry.js';
import { assertOrgSearchQuota } from './quotas.js';

/** 默认职衔白名单（03 §3.4 jobTitles 缺省值） */
export const DEFAULT_JOB_TITLES = [
  'Purchasing Manager',
  'Buyer',
  'Sourcing Manager',
  'Procurement Director',
] as const;

/**
 * 决策影响力确定性映射（04 需求 §3.2，无 AI 判断、可复算）：
 * 90 = 采购决策层（Director/VP/Head/Chief/CPO + 采购职能词）；
 * 75 = 采购执行层（Purchasing/Sourcing/Procurement Manager、Buyer、Merchandiser）；
 * 40 = 影响层（Engineer/R&D/Quality 等识别到但非采购职能）；未命中 → null（不猜测）。
 */
export function mapDecisionInfluence(title: string): number | null {
  const t = title.toLowerCase();
  const buying = /(purchasing|sourcing|procurement|buying)/.test(t);
  const executive = /(director|vp|vice president|head|chief|cpo)/.test(t);
  if (executive && buying) {
    return 90;
  }
  const executor =
    /(purchasing|sourcing|procurement)\s+manager/.test(t) ||
    /(^|\s)buyer(\s|$)/.test(t) ||
    /merchandiser/.test(t);
  if (executor) {
    return 75;
  }
  if (/(engineer|r&d|quality)/.test(t)) {
    return 40;
  }
  return null;
}

// ===== 公开渠道联系人抽取（06 §3.1：搜索供应商 Heuristics；禁止合成/猜测，08 §6）=====

/** 单公司联系人上限（抑制噪声入库与外部调用放大） */
const MAX_CONTACTS = 5;

/**
 * 非人名高频词（职务、公司后缀、站点导航、社媒、国家、月份等）。
 * 命中任一词即判定姓名候选无效——宁可漏抽，不可把标题/公司名误当人名（数据可信红线）。
 */
const NAME_STOP_WORDS = new Set([
  'purchasing',
  'procurement',
  'sourcing',
  'supply',
  'chain',
  'logistics',
  'buyer',
  'buyers',
  'merchandiser',
  'merchandising',
  'sales',
  'marketing',
  'operations',
  'operation',
  'finance',
  'accounting',
  'engineer',
  'engineering',
  'quality',
  'product',
  'products',
  'production',
  'manager',
  'director',
  'directors',
  'officer',
  'president',
  'vice',
  'head',
  'lead',
  'specialist',
  'executive',
  'supervisor',
  'coordinator',
  'analyst',
  'assistant',
  'associate',
  'senior',
  'junior',
  'chief',
  'owner',
  'founder',
  'partner',
  'consultant',
  'customer',
  'service',
  'support',
  'admin',
  'team',
  'career',
  'careers',
  'hr',
  'staff',
  'contact',
  'contacts',
  'email',
  'emails',
  'phone',
  'tel',
  'fax',
  'address',
  'location',
  'about',
  'home',
  'page',
  'copyright',
  'privacy',
  'policy',
  'terms',
  'login',
  'sign',
  'register',
  'menu',
  'search',
  'blog',
  'news',
  'faq',
  'help',
  'review',
  'reviews',
  'shop',
  'store',
  'cart',
  'wholesale',
  'retail',
  'cases',
  'accessories',
  'speakers',
  'inc',
  'llc',
  'ltd',
  'limited',
  'gmbh',
  'corp',
  'corporation',
  'company',
  'group',
  'holdings',
  'industries',
  'solutions',
  'services',
  'usa',
  'america',
  'american',
  'canada',
  'china',
  'chinese',
  'germany',
  'german',
  'europe',
  'european',
  'uk',
  'global',
  'worldwide',
  'international',
  'states',
  'united',
  'www',
  'http',
  'https',
  'com',
  'net',
  'org',
  'html',
  'linkedin',
  'facebook',
  'twitter',
  'instagram',
  'youtube',
  'pinterest',
  'tiktok',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]);

/** 姓名词元：首字母大写的英文词（含 O'Brien / Smith-Jones / 中间名缩写 J.） */
const NAME_TOKEN_RE = /^(?:[A-Z][a-z'’-]{1,20}|[A-Z]\.)$/;

function isNameToken(token: string): boolean {
  return NAME_TOKEN_RE.test(token);
}

/** 去前后非字母噪声（保留词内撇号/连字符与缩写点：Lee, → Lee；J. → J.） */
function cleanToken(token: string): string {
  return token.replace(/^[^A-Za-z]+/, '').replace(/[^A-Za-z.]+$/, '');
}

/**
 * 职衔正则（采购/供应链口径，04 需求 §3.2 决策影响力映射前置）。
 * 未命中返回 null → 该条不产联系人（不猜职务）。
 */
const TITLE_PATTERNS: RegExp[] = [
  /\bchief\s+procurement\s+officer\b/i,
  /\b(?:vp|vice\s+president|director|head)\s+of\s+(?:procurement|purchasing|sourcing|supply\s+chain)\b/i,
  /\b(?:procurement|purchasing|sourcing|strategic\s+sourcing|supply\s+chain)\s+(?:manager|director|head|officer|vp|lead|supervisor|specialist|executive|coordinator|analyst|agent|buyer)\b/i,
  /\b(?:(?:senior|sr\.?|junior|jr\.?|assistant|associate)\s+)?buyer\b/i,
  /\bmerchandis(?:er|ing\s+manager)\b/i,
  /\b(?:materials?|inventory|logistics|operations|warehouse)\s+manager\b/i,
];

/** 公开邮箱提取（大小写归一；host 必须归属公司域名，禁自由邮箱/个人隐私，08 §7） */
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;

/** 非邮箱后缀（图片/脚本文件名常被 email 正则误捕获） */
const NON_EMAIL_TLDS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'css', 'js', 'json']);

/** 角色邮箱（info@ / sales@ …）：公开商务渠道，但不归属具体自然人，禁止绑定到人名下 */
const ROLE_MAILBOXES = new Set([
  'info',
  'sales',
  'contact',
  'contacts',
  'support',
  'service',
  'admin',
  'office',
  'hello',
  'team',
  'help',
  'enquiry',
  'enquiries',
  'inquiry',
  'orders',
  'order',
  'export',
  'import',
  'cs',
  'customerservice',
  'mail',
  'billing',
  'accounts',
  'careers',
  'hr',
  'press',
  'media',
  'marketing',
]);

/** jobTitles 白名单排序（03 §3.4：命中白名单者优先，按白名单顺序；其余按影响力降序） */
function rankContacts(contacts: LeadContact[], jobTitles: string[]): LeadContact[] {
  const order = new Map(jobTitles.map((t, i) => [t.toLowerCase().trim(), i]));
  return [...contacts].sort((a, b) => {
    const ra = order.get((a.title ?? '').toLowerCase().trim());
    const rb = order.get((b.title ?? '').toLowerCase().trim());
    if (ra !== undefined || rb !== undefined) {
      return (ra ?? Number.MAX_SAFE_INTEGER) - (rb ?? Number.MAX_SAFE_INTEGER);
    }
    return (b.decisionInfluencePct ?? -1) - (a.decisionInfluencePct ?? -1);
  });
}

/** 人物检索查询（公开渠道；姓名/职衔均取自搜索结果，不合成） */
export function buildPeopleQuery(
  companyName: string,
  domain: string | undefined,
  jobTitles: string[],
): string {
  const quote = (s: string) => `"${s.replace(/"/g, ' ').trim()}"`;
  const titles = (jobTitles.length > 0 ? jobTitles : [...DEFAULT_JOB_TITLES])
    .slice(0, 4)
    .map(quote)
    .join(' OR ');
  const scope = domain ? quote(domain) : quote(companyName);
  return `${scope} (${titles})`;
}

/**
 * 从文本抽取首个可信英文人名（抽不到返回 null，不做二次推断）。
 * 以词元滑窗（优先 3 词、退回 2 词）逐位扫描，避免正则贪婪匹配把公司名/职务串吃成人名；
 * 命中停用词（职务/导航/国家…）或 `excludeWords`（公司名/域名词）即判定该窗口无效。
 */
export function extractPersonName(
  text: string,
  excludeWords: readonly string[] = [],
): string | null {
  const exclude = new Set(
    excludeWords.map((w) => w.toLowerCase().replace(/[^a-z]/g, '')).filter((w) => w.length > 2),
  );
  const tokens = text.split(/\s+/).map(cleanToken);
  for (let i = 0; i + 1 < tokens.length; i++) {
    for (const size of [3, 2]) {
      if (i + size > tokens.length) {
        continue;
      }
      const window = tokens.slice(i, i + size);
      if (!window.every(isNameToken)) {
        continue;
      }
      const polluted = window.some((w) => {
        const key = w.toLowerCase().replace(/[^a-z]/g, '');
        return key.length < 2 || NAME_STOP_WORDS.has(key) || exclude.has(key);
      });
      if (polluted) {
        continue;
      }
      const name = window.join(' ');
      if (name.length <= 60) {
        return name;
      }
    }
  }
  return null;
}

/** 抽取职衔：jobTitles 白名单优先（口径统一），否则回落采购/供应链职衔正则 */
export function extractJobTitle(text: string, jobTitles: string[]): string | null {
  const lower = text.toLowerCase();
  for (const t of jobTitles) {
    const norm = t.toLowerCase().trim();
    if (norm && lower.includes(norm)) {
      return t.trim();
    }
  }
  for (const re of TITLE_PATTERNS) {
    const m = re.exec(text);
    if (m?.[0]) {
      return m[0].replace(/\s+/g, ' ').trim();
    }
  }
  return null;
}

/** 命中是否指向本公司（域名根词出现在 url/文本中）；无域名时不做归属判定 */
function mentionsDomain(
  hit: { url: string; title: string; snippet: string },
  domain: string,
): boolean {
  const root = domain.replace(/^www\./, '').split('.')[0] ?? '';
  if (root.length < 4) {
    return false;
  }
  return `${hit.url} ${hit.title} ${hit.snippet}`.toLowerCase().includes(root.toLowerCase());
}

/**
 * 搜索结果 → 联系人候选：必须同时抽到「可信人名 + 职衔」才产出，
 * 且本公司域名须被命中文本提及（防止把别家公司的人串到本条 lead，03 §3.6）。
 */
export function contactsFromHits(
  hits: { url: string; title: string; snippet: string }[],
  companyName: string,
  domain: string | undefined,
  jobTitles: string[],
): LeadContact[] {
  const seen = new Set<string>();
  const contacts: LeadContact[] = [];
  // 排除词：公司名/域名词不得充当人名（搜索结果常以「公司名 - 职衔」形式出现）
  const excludeWords = [...companyName.split(/\s+/), ...(domain ? domain.split(/[.-]/) : [])];
  for (const hit of hits) {
    if (domain && !mentionsDomain(hit, domain)) {
      continue;
    }
    const text = `${hit.title} ${hit.snippet}`;
    const name = extractPersonName(text, excludeWords);
    const title = extractJobTitle(text, jobTitles);
    if (!name || !title) {
      continue;
    }
    const dedup = `${name}@${title}`.toLowerCase();
    if (seen.has(dedup)) {
      continue;
    }
    seen.add(dedup);
    contacts.push({
      companyName,
      domain,
      name,
      title,
      decisionInfluencePct: mapDecisionInfluence(title),
    });
    if (contacts.length >= MAX_CONTACTS) {
      break;
    }
  }
  return contacts;
}

/** 从公开文本抽取归属该公司域名的商务邮箱（去重、去图片等非邮箱串） */
export function extractCompanyEmails(text: string, domain: string): string[] {
  const found = new Set<string>();
  for (const m of text.toLowerCase().matchAll(EMAIL_RE)) {
    const email = m[0];
    const [local, host] = email.split('@');
    if (!local || !host) {
      continue;
    }
    const tld = host.split('.').pop() ?? '';
    // 图片/脚本文件名被 email 正则误捕获（如 logo@2x.png）
    if (NON_EMAIL_TLDS.has(tld)) {
      continue;
    }
    // 归属判定：仅限公司域名（含子域），不收自由邮箱（gmail/yahoo…）
    if (host !== domain && !host.endsWith(`.${domain}`)) {
      continue;
    }
    found.add(email);
  }
  return [...found];
}

/** 邮箱是否角色邮箱（info@/sales@…） */
export function isRoleMailbox(email: string): boolean {
  const local = email.split('@')[0] ?? '';
  return ROLE_MAILBOXES.has(local.split(/[._-]/)[0] ?? '');
}

/** 自然人邮箱绑定判据：邮箱 local-part 须与姓名组合（first.last / flast / firstlast…）一致 */
export function emailMatchesName(email: string, name: string): boolean {
  const local = email.split('@')[0] ?? '';
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
  const parts = name
    .split(/\s+/)
    .map(norm)
    .filter((p) => p.length > 1);
  if (parts.length < 2) {
    return false;
  }
  const [first = '', last = ''] = parts;
  const l = norm(local);
  return [
    `${first}.${last}`,
    `${first}${last}`,
    `${first[0] ?? ''}${last}`,
    `${first[0] ?? ''}.${last}`,
    `${first}-${last}`,
    `${last}${first}`,
  ].some((c) => c.length > 3 && c === l);
}

// ===== 官网联系页发现与抽取（M4-6，06 §3.1 公开渠道）=====
// 背景：大量中小 B2B 公司没有 LinkedIn 暴露，但官网 /contact、/about、/team 页上有真实
// 商务邮箱与员工姓名职衔。仅靠「人名 + 职衔」检索式命中率极低（搜索摘要往往不含二者），
// 因此站点内联系页是联系人发现的主数据源；姓名/职衔/邮箱一律取自页面真实文本（08 §6）。

/** 单公司联系页抓取上限（不含首页；叠加单站限速，控制单节点耗时） */
const CONTACT_PAGE_LIMIT = 3;

/** 首页无联系页链接时的兜底路径（含 .htm 静态站） */
const CONTACT_FALLBACK_PATHS = [
  '/contact',
  '/contact.htm',
  '/contact.html',
  '/contact-us',
  '/about',
  '/team',
];

/** 首页链接 → 联系页候选（路径关键词命中） */
const CONTACT_PATH_RE =
  /\/(contact|about|team|people|staff|leadership|our-?company|company)[^/]*$/i;

/**
 * 非自然人邮箱 local-part（角色邮箱见 ROLE_MAILBOXES）：
 * 这些邮箱不属于具体自然人，禁止还原为姓名（08 §6 数据可信红线）。
 */
const NON_PERSON_LOCALS = new Set([
  'webmaster',
  'postmaster',
  'hostmaster',
  'abuse',
  'noreply',
  'donotreply',
  'bounce',
  'privacy',
  'legal',
  'billing',
  'payable',
  'receivable',
  'invoice',
  'invoices',
  'accounting',
  'payroll',
  'jobs',
  'job',
  'recruiting',
  'career',
  'newsletter',
  'subscribe',
  'unsubscribe',
  'shop',
  'store',
  'orders',
  'quote',
  'quotes',
  'estimate',
  'proof',
  'proofs',
  'art',
  'design',
  'production',
  'shipping',
  'returns',
  'it',
  'web',
  'site',
  'ftp',
  'test',
  'example',
  'you',
  'your',
  'email',
  'name',
  'first',
  'last',
  'fullname',
  'company',
  'phone',
  'address',
  'comments',
]);

/** 联系页优先级：contact > team/people > about/company */
function contactPageScore(url: string): number {
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return 3;
  }
  if (path.includes('contact')) {
    return 0;
  }
  if (/(team|people|staff|leadership)/.test(path)) {
    return 1;
  }
  if (/(about|company)/.test(path)) {
    return 2;
  }
  return 3;
}

/** 首页链接中挑联系页候选；无命中则回落已知路径（www/根域同站限定，防跨站串数据） */
export function candidateContactPages(home: FetchedPage | null, domain: string): string[] {
  const hosts = new Set([domain, `www.${domain}`]);
  const links = (home?.links ?? [])
    .flatMap((link) => {
      try {
        const u = new URL(link);
        const host = u.hostname.replace(/^www\./, '').toLowerCase();
        return CONTACT_PATH_RE.test(u.pathname) ? [{ href: u.toString(), host }] : [];
      } catch {
        return [];
      }
    })
    .filter((l) => hosts.has(l.host))
    .map((l) => l.href);
  const picked = [...new Set(links)]
    .sort((a, b) => contactPageScore(a) - contactPageScore(b))
    .slice(0, CONTACT_PAGE_LIMIT);
  if (picked.length > 0) {
    return picked;
  }
  return CONTACT_FALLBACK_PATHS.slice(0, 2).map((p) => `https://${domain}${p}`);
}

/** 抓取官网联系页（首页 → 首页联系页链接 → 兜底路径；失败逐页降级不中断） */
async function loadContactPages(
  provider: SearchProvider,
  domain: string,
  cache: Map<string, FetchedPage[]>,
): Promise<{ pages: FetchedPage[]; failures: string[] }> {
  const cached = cache.get(domain);
  if (cached) {
    return { pages: cached, failures: [] };
  }
  const failures: string[] = [];
  const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));
  const bases = [`https://${domain}`, `https://www.${domain}`];
  let home: FetchedPage | null = null;
  for (const base of bases) {
    try {
      home = await provider.fetchPage(base);
      break;
    } catch (err) {
      failures.push(reason(err));
    }
  }
  const pages: FetchedPage[] = home ? [home] : [];
  for (const url of candidateContactPages(home, domain)) {
    if (pages.length > CONTACT_PAGE_LIMIT) {
      break;
    }
    try {
      pages.push(await provider.fetchPage(url));
    } catch (err) {
      failures.push(reason(err));
    }
  }
  cache.set(domain, pages);
  return { pages, failures };
}

/**
 * 邮箱 local-part → 自然人姓名（ashley → Ashley；john.smith → John Smith）。
 * 仅还原「像人名的」local-part：全字母、每段 2~20 字符、非角色/非停用词、非公司名/域名词；
 * 还原失败返回 null（不猜姓名，08 §6）。
 */
export function nameFromEmailLocal(
  local: string,
  excludeWords: readonly string[] = [],
): string | null {
  const parts = local
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((p) => p.length > 0);
  if (parts.length === 0 || parts.length > 3) {
    return null;
  }
  if (!parts.every((p) => /^[a-z]{2,20}$/.test(p))) {
    return null;
  }
  const exclude = new Set(
    excludeWords.map((w) => w.toLowerCase().replace(/[^a-z]/g, '')).filter((w) => w.length > 2),
  );
  if (parts.some((p) => NAME_STOP_WORDS.has(p) || NON_PERSON_LOCALS.has(p) || exclude.has(p))) {
    return null;
  }
  return parts.map((p) => `${p[0]?.toUpperCase() ?? ''}${p.slice(1)}`).join(' ');
}

/** 同一自然人判定：姓名全等，或一方为另一方的名/姓前缀（Ashley ↔ Ashley Smith） */
export function samePerson(a: string, b: string): boolean {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (!na || !nb) {
    return false;
  }
  return na === nb || na.startsWith(`${nb} `) || nb.startsWith(`${na} `);
}

/** 合并候选联系人（补全职衔/邮箱，不覆盖已有值；姓名保留更完整的一方） */
export function mergeContact(list: LeadContact[], candidate: LeadContact): void {
  const name = candidate.name;
  if (!name) {
    return;
  }
  const exist = list.find((c) => samePerson(c.name ?? '', name));
  if (!exist) {
    if (list.length >= MAX_CONTACTS) {
      return;
    }
    list.push(candidate);
    return;
  }
  if (name.length > (exist.name ?? '').length) {
    exist.name = name;
  }
  if (!exist.title && candidate.title) {
    exist.title = candidate.title;
    exist.decisionInfluencePct = mapDecisionInfluence(candidate.title);
  }
  if (!exist.email && candidate.email) {
    exist.email = candidate.email;
  }
}

/**
 * 联系页正文 → 联系人候选：
 * ① 同一行/段内「姓名 + 采购职衔」→ 姓名 + 职衔；
 * ② 公司域名下的非角色邮箱 → local-part 还原姓名并绑定邮箱，就近窗口（±160 字符）补职衔。
 * 角色邮箱（info@/sales@…）仅留痕，不绑定自然人（03 §4 / 08 §6）。
 */
export function contactsFromPages(
  pages: FetchedPage[],
  companyName: string,
  domain: string,
  jobTitles: string[],
): { contacts: LeadContact[]; roleEmails: string[] } {
  const excludeWords = [...companyName.split(/\s+/), ...domain.split(/[.-]/)];
  const contacts: LeadContact[] = [];
  const roleEmails: string[] = [];
  for (const page of pages) {
    // ① 姓名 + 职衔（逐段扫描，避免跨段拼接出假人）
    for (const segment of page.text.split(/\n+/)) {
      const title = extractJobTitle(segment, jobTitles);
      if (!title) {
        continue;
      }
      const name = extractPersonName(segment, excludeWords);
      if (!name) {
        continue;
      }
      mergeContact(contacts, {
        companyName,
        domain,
        name,
        title,
        decisionInfluencePct: mapDecisionInfluence(title),
      });
    }
    // ② 公司域名邮箱（先按「local-part ↔ 姓名组合」绑定到既有联系人，再退回 local-part 还原姓名）
    const lowerText = page.text.toLowerCase();
    for (const email of extractCompanyEmails(page.text, domain)) {
      if (isRoleMailbox(email)) {
        if (!roleEmails.includes(email)) {
          roleEmails.push(email);
        }
        continue;
      }
      const owner = contacts.find((c) => c.name && emailMatchesName(email, c.name));
      if (owner) {
        if (!owner.email) {
          owner.email = email;
        }
        continue;
      }
      const name = nameFromEmailLocal(email.split('@')[0] ?? '', excludeWords);
      if (!name) {
        continue;
      }
      const at = lowerText.indexOf(email);
      const window = at >= 0 ? page.text.slice(Math.max(0, at - 160), at + email.length + 160) : '';
      const title = window ? extractJobTitle(window, jobTitles) : null;
      mergeContact(contacts, {
        companyName,
        domain,
        name,
        ...(title ? { title } : {}),
        email,
        decisionInfluencePct: title ? mapDecisionInfluence(title) : null,
      });
    }
  }
  return { contacts, roleEmails };
}

/** 跨轮累积（LastValue 通道无 reducer，bag 承载；assemble_leads 消费） */
function bagContacts(ctx: ToolContext): LeadContact[] {
  return (ctx.bag.get('contactsAll') as LeadContact[] | undefined) ?? [];
}

/** 联系页进程内缓存（domain → 已抓页面；find_contact 抓过 lookup_contact 直接复用） */
function contactPageCache(ctx: ToolContext): Map<string, FetchedPage[]> {
  const existing = ctx.bag.get('contactPages') as Map<string, FetchedPage[]> | undefined;
  if (existing) {
    return existing;
  }
  const created = new Map<string, FetchedPage[]>();
  ctx.bag.set('contactPages', created);
  return created;
}

/** 域名归一（去协议/去 www/小写），与 flows.normDomain 同口径 */
function normalizeDomain(domain?: string | null): string | undefined {
  const d = (domain ?? '')
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .toLowerCase()
    .trim();
  return d || undefined;
}

/**
 * 公司/联系人归并键（03 §3.6 去重口径：归一化域名优先，名称兜底）。
 * 仅按公司名归并会在同名不同域名时串数据（mock 供应商的公司名即查询词，必然同名）。
 */
function entityKey(companyName: string, domain?: string | null): string {
  return normalizeDomain(domain) ?? companyName.toLowerCase().trim();
}

/** 搜索 hit → 公司候选（域名提取 + 标题派生公司名；country 缺省由 assemble_leads 兜底） */
function hitToCompany(hit: { title: string; url: string }): CompanyLead | null {
  let domain: string | null = null;
  try {
    domain = new URL(hit.url).hostname.replace(/^www\./, '');
  } catch {
    domain = null;
  }
  if (!domain) {
    return null;
  }
  const fromTitle = hit.title.split(/[|–—-]/)[0]?.trim() ?? '';
  const companyName =
    fromTitle.length >= 2
      ? fromTitle.slice(0, 80)
      : (domain.split('.')[0]?.replace(/^\w/, (c) => c.toUpperCase()) ?? domain);
  return {
    companyName,
    domain,
    website: `https://${domain}`,
    source: 'web_search',
  };
}

export const webSearchTool: ToolDefinition<
  { queries: string[] },
  { companies: (CompanyLead & { source: string })[] }
> = {
  name: 'web_search',
  description: '按搜索词执行网页搜索，返回公司候选（外部配额 ×1 + org 级搜索日额度）',
  inputSchema: z.object({ queries: z.array(z.string().min(1)).min(1).max(20) }),
  riskLevel: 'low',
  quotaWeight: 1,
  async execute(ctx, input) {
    // 翻页/换词（LangGraph 00 §2.2 C2）：轮次计数由 bag 承载，逐轮轮换搜索词映射到供应商分页。
    const round = ((ctx.bag.get('searchRound') as number | undefined) ?? 0) + 1;
    ctx.bag.set('searchRound', round);
    const query = input.queries[(round - 1) % input.queries.length] ?? input.queries[0] ?? '';
    await writeToolLog(ctx, TASK_LOG_TYPE.SEARCH, `第 ${round} 轮搜索：${query}`);

    // org 级供应商日额度（06 §3 令牌桶，org 时区日界）
    await assertOrgSearchQuota(ctx, 1);

    // 按 org 解析选用的搜索供应商（系统设置 → AI 模型配置；未配置回落环境变量）
    const provider = await getSearchProvider(ctx.orgId);
    const hits = await provider.webSearch(query, round);
    const companies: (CompanyLead & { source: string })[] = hits
      .map(hitToCompany)
      .filter((c): c is CompanyLead & { source: string } => c !== null);

    // 真实供应商不产伪数据（无依据字段缺失，硬过滤跳过——CompanyLead 契约）

    if (companies.length === 0) {
      await writeToolLog(ctx, TASK_LOG_TYPE.FOUND, `第 ${round} 轮搜索无新候选`);
      return { companies: [] };
    }
    for (const c of companies) {
      await writeToolLog(ctx, TASK_LOG_TYPE.FOUND, `发现公司 ${c.companyName}（${c.domain}）`);
    }
    return { companies };
  },
};

export const siteCrawlTool: ToolDefinition<
  { domain: string; companyName: string },
  {
    summary: string;
    products: string[];
    crawledPages: string[];
    /** 站点是否可达（降级返回时为 false，summary 为空） */
    reachable?: boolean;
    /** 降级原因（不可达时写入，进日志与 State） */
    note?: string;
  }
> = {
  name: 'site_crawl',
  description:
    '抓取官网关键页（产品/About）生成摘要（外部配额 ×2；内容按「不可信数据」注入，08 §6）',
  inputSchema: z.object({ domain: z.string().min(3), companyName: z.string().min(1) }),
  riskLevel: 'low',
  quotaWeight: 2,
  async execute(ctx, input) {
    // org 级供应商日额度（crawl ×2）
    await assertOrgSearchQuota(ctx, 2);
    const provider = await getSearchProvider(ctx.orgId);
    try {
      const result = await provider.crawlSite(input.domain);
      await writeToolLog(
        ctx,
        TASK_LOG_TYPE.CRAWL,
        `抓取 ${input.domain} 完成（${result.crawledPages.length} 页）`,
      );
      return { ...result, reachable: true };
    } catch (err) {
      // 单站不可达（WAF 403 / 超时 / DNS / robots 全禁）不应中断整条获客任务：
      // 记录原因后以空摘要降级，后续 match_product / 联系人等节点照常执行。
      const reason = err instanceof Error ? err.message : String(err);
      await writeToolLog(
        ctx,
        TASK_LOG_TYPE.CRAWL,
        `抓取 ${input.domain} 失败，跳过该站：${reason}`,
      );
      return { summary: '', products: [], crawledPages: [], reachable: false, note: reason };
    }
  },
};

/**
 * find_contact（LangGraph 00 §2.3，M4-1 工具化）：发现潜在采购负责人（职位/部门匹配），
 * 按 jobTitles 白名单排序 + 决策影响力 90/75/40 档确定性映射（未命中 null，04 需求 §3.2）。
 * 数据源 = 已注入的搜索供应商**公开渠道**（06 §3.1）：姓名/职衔自真实搜索返回文本抽取，
 * 抽不到（无公开线索/供应商异常）一律不产数据并留痕；禁止合成姓名与联系方式（08 §6）。
 */
export const findContactTool: ToolDefinition<
  { companyName: string; domain?: string; jobTitles?: string[] },
  { contacts: LeadContact[] }
> = {
  name: 'find_contact',
  description: '发现潜在采购负责人并按职衔规则产出决策影响力基线（04 需求 §3.2）',
  inputSchema: z.object({
    companyName: z.string().min(1),
    domain: z.string().optional(),
    jobTitles: z.array(z.string().min(1)).optional(),
  }),
  riskLevel: 'low',
  quotaWeight: 1,
  async execute(ctx, input) {
    const jobTitles = input.jobTitles?.length ? input.jobTitles : [...DEFAULT_JOB_TITLES];
    const domain = normalizeDomain(input.domain);
    const query = buildPeopleQuery(input.companyName, domain, jobTitles);
    // 外部配额（06 §3：公开渠道检索计 ×1 + 站内抓页 ×2；超限抛 RATE_LIMITED → 任务转 paused）
    await assertOrgSearchQuota(ctx, 1);
    const merged: LeadContact[] = [];
    let siteNote = '';
    try {
      const provider = await getSearchProvider(ctx.orgId);
      // ① 人物检索（LinkedIn/团队页等公开渠道）：同一条命中须同时含姓名与职衔
      const hits = await provider.webSearch(query, 1);
      for (const c of contactsFromHits(hits, input.companyName, domain, jobTitles)) {
        mergeContact(merged, c);
      }
      // ② 官网联系页（/contact、/about、/team…）：姓名 + 职衔 + 公司域名邮箱
      if (domain) {
        await assertOrgSearchQuota(ctx, 2);
        const loaded = await loadContactPages(provider, domain, contactPageCache(ctx));
        const fromPages = contactsFromPages(loaded.pages, input.companyName, domain, jobTitles);
        for (const c of fromPages.contacts) {
          mergeContact(merged, c);
        }
        siteNote = `；官网抓页 ${loaded.pages.length} 页${
          fromPages.roleEmails.length > 0
            ? `，角色邮箱 ${fromPages.roleEmails.join('、')}（未绑定自然人）`
            : ''
        }${loaded.failures.length > 0 ? `，失败 ${loaded.failures.length} 页` : ''}`;
      }
      const contacts = rankContacts(merged, jobTitles);
      if (contacts.length === 0) {
        await writeToolLog(
          ctx,
          TASK_LOG_TYPE.CONTACT,
          `公开渠道未见采购负责人线索，跳过 ${input.companyName} 的联系人发现（检索式：${query}${siteNote}）`,
        );
        return { contacts: [] };
      }
      // 跨轮累积（State.contacts 为 LastValue 通道逐轮覆盖，汇总以 bag 为准）
      ctx.bag.set('contactsAll', [...bagContacts(ctx), ...contacts]);
      await writeToolLog(
        ctx,
        TASK_LOG_TYPE.CONTACT,
        `发现联系人 ${contacts.length} 名（${input.companyName}）：${contacts
          .map(
            (c) =>
              `${c.name}${c.title ? `/${c.title}` : ''}${c.email ? ` <${c.email}>` : ''}${
                c.decisionInfluencePct === null ? '' : `(${c.decisionInfluencePct}%)`
              }`,
          )
          .join('、')}${siteNote}`,
      );
      return { contacts };
    } catch (err) {
      // 额度耗尽是任务级信号（06 §3：超限转 paused），不可吞成「跳过」。
      if (err instanceof BizException && err.code === ErrorCode.RATE_LIMITED) {
        throw err;
      }
      // 单公司查找失败（供应商异常/网络）不中断整条获客任务：记原因后跳过。
      const reason = err instanceof Error ? err.message : String(err);
      await writeToolLog(
        ctx,
        TASK_LOG_TYPE.CONTACT,
        `联系人发现失败，跳过 ${input.companyName}：${reason}`,
      );
      return { contacts: [] };
    }
  },
};

/**
 * lookup_contact（LangGraph 00 §2.3）：仅查找公开商务渠道联系方式（GDPR/CCPA 合规边界，03 §4）。
 * 数据源 = 已注入的搜索供应商的公司站内/公开页（`site:<domain>` 检索 + **官网联系页正文**，
 * 06 §3.1 站内邮箱启发式；联系页与 find_contact 共享 bag 缓存，同域名不重复抓）：
 * - 仅收**公司域名下真实出现**的邮箱，自由邮箱（gmail 等）不入库；
 * - 自然人邮箱须 local-part 与姓名组合一致（或 local-part 可还原为同一姓名）才绑定，
 *   角色邮箱（info@/sales@…）不挂到人名下；
 * - 抽不到即保持 `email` 为空，不按格式猜测合成（08 §6 数据可信红线）。外部配额 ×1。
 */
export const lookupContactTool: ToolDefinition<
  { companyName: string; domain?: string },
  { contacts: LeadContact[]; lookedUp: number }
> = {
  name: 'lookup_contact',
  description: '查找公开商务渠道联系方式（合规边界：仅公开渠道，禁止隐私数据，03 §4）',
  inputSchema: z.object({
    companyName: z.string().min(1),
    domain: z.string().optional(),
  }),
  riskLevel: 'low',
  quotaWeight: 1,
  async execute(ctx, input) {
    const all = bagContacts(ctx);
    // 归并键与 03 §3.6 一致（域名优先）：同名不同域名的公司不得互相补全/互相返回
    const target = entityKey(input.companyName, input.domain);
    const own = all.filter((c) => entityKey(c.companyName, c.domain) === target);
    const domain = normalizeDomain(input.domain);
    // 无域名的公司无法确定邮箱归属（防止串公司），直接跳过并留痕
    if (!domain) {
      await writeToolLog(
        ctx,
        TASK_LOG_TYPE.LOOKUP,
        `无官网域名，无法判定邮箱归属，跳过 ${input.companyName} 的公开联系方式查找`,
      );
      return { contacts: own, lookedUp: 0 };
    }
    const pending = own.filter((c) => c.name && !c.email);
    if (pending.length === 0) {
      await writeToolLog(
        ctx,
        TASK_LOG_TYPE.LOOKUP,
        own.length > 0
          ? `${input.companyName} 无待补全联系方式（无候选/已补全）`
          : `无候选联系人，跳过 ${input.companyName} 的公开联系方式查找`,
      );
      return { contacts: own, lookedUp: 0 };
    }
    await assertOrgSearchQuota(ctx, 1);
    try {
      const provider = await getSearchProvider(ctx.orgId);
      const hits = await provider.webSearch(`site:${domain} contact`, 1);
      // 官网联系页（find_contact 已抓过则直接复用 bag 缓存，不再消耗抓取额度）
      const cache = contactPageCache(ctx);
      if (!cache.has(domain)) {
        await assertOrgSearchQuota(ctx, 2);
      }
      const { pages } = await loadContactPages(provider, domain, cache);
      // 自然人邮箱（按姓名绑定）+ 角色邮箱（仅留痕，不挂到人名下）
      const personEmails = new Map<string, string>();
      const roleEmails: string[] = [];
      const texts = [
        ...hits.map((hit) => `${hit.title} ${hit.snippet}`),
        ...pages.map((page) => page.text),
      ];
      for (const text of texts) {
        for (const email of extractCompanyEmails(text, domain)) {
          if (isRoleMailbox(email)) {
            if (!roleEmails.includes(email)) {
              roleEmails.push(email);
            }
            continue;
          }
          const fromLocal = nameFromEmailLocal(email.split('@')[0] ?? '');
          const owner = pending.find((c) => {
            const name = c.name;
            if (!name || personEmails.has(name.toLowerCase())) {
              return false;
            }
            return (
              emailMatchesName(email, name) || (fromLocal !== null && samePerson(fromLocal, name))
            );
          });
          if (owner?.name) {
            personEmails.set(owner.name.toLowerCase(), email);
          }
        }
      }
      let filled = 0;
      const contacts = own.map((c) => {
        const found = c.name ? personEmails.get(c.name.toLowerCase()) : undefined;
        if (found && !c.email) {
          filled++;
          return { ...c, email: found };
        }
        return c;
      });
      // 回写 bag（含已补全邮箱）：assemble_leads 以 bag 累积为准
      ctx.bag.set('contactsAll', [
        ...all.filter((c) => entityKey(c.companyName, c.domain) !== target),
        ...contacts,
      ]);
      await writeToolLog(
        ctx,
        TASK_LOG_TYPE.LOOKUP,
        `${input.companyName} 公开渠道邮箱（官网 ${pages.length} 页 + 站内检索）：补全 ${filled} 个${
          roleEmails.length > 0 ? `，角色邮箱 ${roleEmails.join('、')}（未绑定自然人）` : ''
        }${filled === 0 && roleEmails.length === 0 ? '（未发现公开邮箱，保留空值不猜测）' : ''}`,
      );
      return { contacts, lookedUp: filled };
    } catch (err) {
      if (err instanceof BizException && err.code === ErrorCode.RATE_LIMITED) {
        throw err;
      }
      const reason = err instanceof Error ? err.message : String(err);
      await writeToolLog(
        ctx,
        TASK_LOG_TYPE.LOOKUP,
        `公开联系方式查找失败，跳过 ${input.companyName}：${reason}`,
      );
      return { contacts: own, lookedUp: 0 };
    }
  },
};

/**
 * lead_scoring：确定性规则 + LLM 评分混合（05 §3）。
 * M4-1：match_product 节点以 LLM 直出（Insight Schema），本工具保留为降级/独立评分入口。
 */
export const leadScoringTool: ToolDefinition<
  { companyName: string; country?: string; keywords?: string[] },
  {
    matchPct: number;
    scoreLevel: 'high' | 'medium' | 'low';
    reasons: { text: string; source?: string }[];
  }
> = {
  name: 'lead_scoring',
  description: '对候选公司执行确定性评分并输出可解释 reasons（Insight Schema 红线）',
  inputSchema: z.object({
    companyName: z.string().min(1),
    country: z.string().optional(),
    keywords: z.array(z.string()).optional(),
  }),
  riskLevel: 'low',
  async execute(ctx, input) {
    let pct = 55;
    const reasons: { text: string; source?: string }[] = [];
    if (input.keywords?.length) {
      pct += Math.min(30, input.keywords.length * 10);
      reasons.push({ text: `关键词命中：${input.keywords.join('、')}`, source: 'rule' });
    }
    if (input.country) {
      pct += 5;
      reasons.push({ text: `目标市场所在地区：${input.country}`, source: 'rule' });
    }
    pct = Math.min(97, pct);
    const scoreLevel = pct >= 85 ? 'high' : pct >= 60 ? 'medium' : 'low';
    reasons.push({ text: `综合匹配度 ${pct}%（确定性规则基线）`, source: 'rule' });
    await writeToolLog(
      ctx,
      TASK_LOG_TYPE.MATCH,
      `${input.companyName} 评分 ${pct}%（${scoreLevel}）`,
    );
    return { matchPct: pct, scoreLevel, reasons };
  },
};

export function registerSearchTools(register: (t: ToolDefinition) => void): void {
  register(webSearchTool);
  register(siteCrawlTool);
  register(findContactTool);
  register(lookupContactTool);
  register(leadScoringTool);
}

export type { ToolContext };
