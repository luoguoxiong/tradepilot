/**
 * 搜索/抓取供应商适配（后端技术方案 06 §3，M4 #6）：
 * - mock：确定性产出（跨轮换词/翻页可复算），保三图 dry-run 与单测可测；
 * - http：Serper 兼容搜索 API（web_search）+ 轻量 HTML 抓取（site_crawl，非 Playwright 渲染，
 *   动态页渲染列后续增强）。
 * 抓取合规（08 §7 获客与数据合规，M4 C8）：robots.txt 尊重（解析失败视为允许，业界惯例）、
 * 单站限速（per-host 最小间隔）、UA 标识（TradePilotBot）、excludeDomains 硬过滤、
 * 数据最小化（只存 title/desc 摘要，不整页入库）。搜索 API 侧 ToS 由供应商契约承担。
 * 进程级注入（同 email-send-config 模式）：worker 启动时 setSearchProviderFactory 一次，
 * 按 org 解析「系统设置 → AI 模型配置」选用的搜索供应商（type=search，06 §3）。
 */

/** 爬虫 UA 标识（08 §7：`TradePilotBot`） */
export const CRAWLER_UA = 'TradePilotBot/1.0 (+https://tradepilot.ai/bot)';

/** 官网关键页（产品/关于摘要来源） */
const CRAWL_PAGES = ['/', '/products', '/about'] as const;

/**
 * 抓取请求头：保持 UA 自报身份不变（合规要求，不伪装浏览器），
 * 补 Accept/Accept-Language 以适配「对缺失标准头直接拦截」的边缘 WAF。
 */
const CRAWL_HEADERS = {
  'user-agent': CRAWLER_UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
} as const;

/** 域名归一：去协议/路径/端口，小写（返回空串表示非法） */
export function normalizeHost(domain: string): string {
  return (
    (domain ?? '')
      .trim()
      .replace(/^https?:\/\//i, '')
      .split('/')[0]
      ?.split('?')[0]
      ?.replace(/:\d+$/, '')
      .toLowerCase() ?? ''
  );
}

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SiteCrawlResult {
  summary: string;
  products: string[];
  crawledPages: string[];
}

export interface SearchProvider {
  /** 单 query 搜索（分页/换词由调用方轮次语义映射，LangGraph 00 §2.2 C2） */
  webSearch(query: string, page?: number): Promise<WebSearchHit[]>;
  /** 抓取官网关键页（/、/products、/about）产出摘要与产品线索 */
  crawlSite(domain: string): Promise<SiteCrawlResult>;
}

// ===== mock（确定性）=====

export class MockSearchProvider implements SearchProvider {
  async webSearch(query: string, page = 1): Promise<WebSearchHit[]> {
    const slug = `p${page}-${query.length}`;
    return [
      {
        title: `${query.slice(0, 40)} | vendor-${slug}.example.com`,
        url: `https://vendor-${slug}.example.com`,
        snippet: `mock 搜索结果：与「${query.slice(0, 24)}」相关的公司页（确定性 mock，M4 供应商适配）`,
      },
    ];
  }

  async crawlSite(domain: string): Promise<SiteCrawlResult> {
    return {
      summary: `[mock 抓取] ${domain}：主营产品与公司介绍摘要（mock 供应商，测试可断言）`,
      products: ['mock product line A', 'mock product line B'],
      crawledPages: ['/', '/products', '/about'],
    };
  }
}

// ===== http（Serper 兼容）=====

export interface HttpSearchOptions {
  baseUrl: string;
  apiKey: string;
  /** 抓取超时 ms（轻量抓取，防爬死挂起任务） */
  fetchTimeoutMs?: number;
  /** excludeDomains 硬过滤（08 §7）：命中域名（含子域）的搜索结果直接剔除 */
  excludeDomains?: string[];
  /** 单站抓取最小间隔 ms（08 §7 单站限速；0 关闭；默认 2000） */
  perHostIntervalMs?: number;
  /** robots.txt 尊重开关（默认开启；robots 获取失败视为允许，业界惯例） */
  respectRobots?: boolean;
  /** robots.txt 缓存 TTL ms（默认 10min，避免同站重复拉取） */
  robotsCacheTtlMs?: number;
}

// ===== 抓取合规基元（08 §7；独立导出便于单测）=====

/** robots.txt 分组（简化解析：user-agent 组 + allow/disallow 前缀规则） */
export interface RobotsGroup {
  agents: string[];
  allow: string[];
  disallow: string[];
}

export function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) {
      lastWasAgent = false;
      continue;
    }
    const idx = line.indexOf(':');
    if (idx < 0) {
      continue;
    }
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current!.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'allow' || key === 'disallow') {
      const target = current ?? groups[groups.length - 1];
      if (!target) {
        continue;
      }
      (key === 'allow' ? target.allow : target.disallow).push(value);
      lastWasAgent = false;
    }
  }
  return groups;
}

/**
 * robots.txt 路径放行判定（08 §7「robots.txt 尊重」）：
 * - 命中 UA（或无专属组回落 `*` 组）→ 取最长前缀匹配规则，平长 allow 优先；
 * - 无匹配规则 / 空文件 / 仅空 Disallow → 允许。
 */
export function robotsAllows(text: string, path: string, agent = 'tradepilotbot'): boolean {
  const groups = parseRobots(text);
  const own = groups.filter((g) => g.agents.includes(agent.toLowerCase()));
  const applicable = own.length > 0 ? own : groups.filter((g) => g.agents.includes('*'));
  if (applicable.length === 0) {
    return true;
  }
  const rules = applicable.flatMap((g) => [
    ...g.allow.map((p) => ({ p, allow: true })),
    ...g.disallow.filter((p) => p !== '').map((p) => ({ p, allow: false })),
  ]);
  const matches = rules.filter((r) => path.startsWith(r.p));
  if (matches.length === 0) {
    return true;
  }
  const best = matches.reduce((a, b) => (b.p.length > a.p.length ? b : a));
  return best.allow;
}

/** excludeDomains 硬过滤（08 §7）：host 归一（去 www.）后精确或子域匹配 */
export function isExcludedDomain(url: string, excludeDomains: string[]): boolean {
  if (excludeDomains.length === 0) {
    return false;
  }
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return false;
  }
  return excludeDomains.some((d) => {
    const norm = d.replace(/^www\./, '').toLowerCase();
    return host === norm || host.endsWith(`.${norm}`);
  });
}

/** 单站限速器（08 §7）：同 host 两次请求间隔 ≥ minIntervalMs */
export class PerHostRateLimiter {
  private readonly lastAt = new Map<string, number>();

  constructor(private readonly minIntervalMs: number) {}

  async acquire(host: string): Promise<void> {
    if (this.minIntervalMs <= 0) {
      return;
    }
    const last = this.lastAt.get(host);
    const now = Date.now();
    const wait = last === undefined ? 0 : last + this.minIntervalMs - now;
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.lastAt.set(host, Date.now());
  }
}

export class HttpSearchProvider implements SearchProvider {
  private readonly limiter: PerHostRateLimiter;
  private readonly robotsCache = new Map<string, { text: string | null; at: number }>();
  private readonly robotsTtlMs: number;
  private readonly respectRobots: boolean;

  constructor(private readonly options: HttpSearchOptions) {
    this.limiter = new PerHostRateLimiter(options.perHostIntervalMs ?? 2_000);
    this.robotsTtlMs = options.robotsCacheTtlMs ?? 10 * 60_000;
    this.respectRobots = options.respectRobots ?? true;
  }

  async webSearch(query: string, page = 1): Promise<WebSearchHit[]> {
    const url = `${this.options.baseUrl.replace(/\/$/, '')}/search`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-API-KEY': this.options.apiKey,
      },
      body: JSON.stringify({ q: query, num: 10, page }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`搜索供应商请求失败（${res.status}）: ${detail.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      organic?: { title?: string; link?: string; snippet?: string }[];
    };
    const exclude = this.options.excludeDomains ?? [];
    return (json.organic ?? [])
      .filter((o) => o.link)
      .map((o) => ({
        title: o.title ?? '',
        url: o.link ?? '',
        snippet: o.snippet ?? '',
      }))
      .filter((hit) => !isExcludedDomain(hit.url, exclude));
  }

  /** robots.txt 拉取（per-host 缓存 + TTL；获取失败视为允许，返回 null） */
  private async getRobots(base: string): Promise<string | null> {
    const cached = this.robotsCache.get(base);
    if (cached && Date.now() - cached.at < this.robotsTtlMs) {
      return cached.text;
    }
    let text: string | null = null;
    try {
      const res = await fetch(`${base}/robots.txt`, {
        signal: AbortSignal.timeout(this.options.fetchTimeoutMs ?? 10_000),
        headers: { 'user-agent': CRAWLER_UA },
      });
      if (res.ok) {
        text = await res.text();
      }
    } catch {
      text = null;
    }
    this.robotsCache.set(base, { text, at: Date.now() });
    return text;
  }

  /**
   * 抓取官网关键页（/、/products、/about）。
   * 根域与 www 变体依次尝试（部分站点仅其一可解析/放行，M4 真实站点鲁棒性）；
   * 两者均无可用页时抛错，错误信息携带每页失败原因（HTTP 状态/超时/robots 禁止）便于定位。
   */
  async crawlSite(domain: string): Promise<SiteCrawlResult> {
    const host = normalizeHost(domain);
    if (!host) {
      throw new Error(`站点抓取失败（域名非法）: ${domain}`);
    }
    // 根域 ⇄ www 变体（先试原样主机，失败再试另一变体）
    const bases = host.startsWith('www.')
      ? [`https://${host}`, `https://${host.slice(4)}`]
      : [`https://${host}`, `https://www.${host}`];
    const failures: string[] = [];
    for (const base of bases) {
      const attempt = await this.crawlBase(base);
      if (attempt.crawled.length > 0) {
        return {
          summary: attempt.summaries.join('\n').slice(0, 2000) || `${domain}（无摘要）`,
          products: attempt.products,
          crawledPages: attempt.crawled,
        };
      }
      failures.push(...attempt.failures);
    }
    const detail = failures.slice(0, 6).join('; ');
    throw new Error(`站点抓取失败（无可达页面）: ${domain}${detail ? ` — ${detail}` : ''}`);
  }

  /** 单主机抓取（原 crawlSite 主体，返回失败明细供上层汇总） */
  private async crawlBase(base: string): Promise<{
    summaries: string[];
    products: string[];
    crawled: string[];
    failures: string[];
  }> {
    const timeoutMs = this.options.fetchTimeoutMs ?? 10_000;
    const summaries: string[] = [];
    const products: string[] = [];
    const crawled: string[] = [];
    const failures: string[] = [];
    for (const p of CRAWL_PAGES) {
      // ① robots.txt 尊重（08 §7）：disallow 路径直接跳过
      if (this.respectRobots) {
        const robots = await this.getRobots(base);
        if (robots !== null && !robotsAllows(robots, p)) {
          failures.push(`${p} robots.txt 禁止`);
          continue;
        }
      }
      // ② 单站限速（08 §7）
      await this.limiter.acquire(base);
      try {
        const res = await fetch(`${base}${p}`, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: CRAWL_HEADERS,
        });
        if (!res.ok) {
          failures.push(`${p} HTTP ${res.status}`);
          continue;
        }
        const html = await res.text();
        crawled.push(p);
        // 数据最小化（08 §7）：只提取 title/meta description 摘要与产品线索，不整页入库
        const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html)?.[1]?.trim();
        const desc =
          /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,400})["']/i
            .exec(html)?.[1]
            ?.trim() ?? '';
        summaries.push(`${p}: ${title ?? ''}${desc ? ` — ${desc}` : ''}`.trim());
        // 产品线索：产品/目录链接锚文本（去重、截断）
        const linkRe =
          /<a[^>]+href=["']([^"']*(?:product|catalog|item)[^"']*)["'][^>]*>([^<]{1,80})<\/a>/gi;
        let m: RegExpExecArray | null;
        while ((m = linkRe.exec(html)) !== null && products.length < 20) {
          const text = (m[2] ?? '').trim();
          if (text && !products.includes(text)) {
            products.push(text);
          }
        }
      } catch (err) {
        // 单页失败跳过（超时/403/网络），其余页继续，原因留存供诊断
        failures.push(`${p} ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { summaries, products, crawled, failures };
  }
}

export function createSearchProvider(options: {
  provider: 'mock' | 'http';
  baseUrl: string;
  apiKey: string;
}): SearchProvider {
  if (options.provider === 'http') {
    return new HttpSearchProvider({ baseUrl: options.baseUrl, apiKey: options.apiKey });
  }
  return new MockSearchProvider();
}

// ===== 进程级注入（未注入默认 mock）=====
// 16 FR-10 扩展后为「按 org 解析」：工厂可读库拿到 org 在「系统设置 → AI 模型配置」选用的
// 搜索供应商（worker 侧装配），未注册工厂时回落到 mock。configureSearchProvider 保留为
// 静态注册（单测/离线演练），签名与旧版一致。

/** org → provider 工厂（异步：需读该 org 的 AI 模型选用配置） */
export type SearchProviderFactory = (orgId?: string) => SearchProvider | Promise<SearchProvider>;

let factory: SearchProviderFactory | null = null;
let defaultProvider: SearchProvider | null = null;

/** 注册 org 级解析工厂（worker 启动时一次） */
export function setSearchProviderFactory(next: SearchProviderFactory): void {
  factory = next;
}

/** 静态注册（忽略 orgId）：等价于固定 provider，单测与离线演练使用 */
export function configureSearchProvider(provider: SearchProvider): void {
  factory = () => provider;
}

export async function getSearchProvider(orgId?: string): Promise<SearchProvider> {
  if (factory) {
    return await factory(orgId);
  }
  defaultProvider ??= new MockSearchProvider();
  return defaultProvider;
}
