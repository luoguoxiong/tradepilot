import '../polyfill.js'; // Node18 File polyfill，cheerio 依赖，必须最先加载
import * as cheerio from 'cheerio';
import { config } from '../config.js';

export interface SearchResult {
  title: string;
  url: string;
  domain: string;
  snippet: string;
  provider: string;
}

/** 电商平台/目录站/社媒黑名单：这些不是目标 B2B 客户官网 */
const BLOCKED_PATTERNS = [
  /amazon\./i, /ebay\./i, /aliexpress\./i, /alibaba\./i, /1688\./i, /dhgate\./i,
  /made-in-china\./i, /globalsources\./i, /wish\.com/i, /temu\./i, /shein\./i,
  /facebook\.com/i, /instagram\.com/i, /linkedin\.com/i, /youtube\.com/i, /tiktok\./i,
  /twitter\.com/i, /x\.com/i, /pinterest\./i, /reddit\.com/i, /wikipedia\.org/i,
  /yelp\.com/i, /trustpilot\.com/i, /crunchbase\.com/i, /bloomberg\.com/i,
  /\.pdf$/i, /medium\.com/i, /quora\.com/i,
];

export function isBlocked(url: string): boolean {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return true;
    return BLOCKED_PATTERNS.some((re) => re.test(u.hostname + u.pathname));
  } catch {
    return true;
  }
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 20_000): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`搜索源 HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** DuckDuckGo HTML 端点（免费无需 key），返回 JSON 供解析 */
export async function searchDuckDuckGo(query: string, limit = 10): Promise<SearchResult[]> {
  const body = new URLSearchParams({ q: query, b: '' });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  let html: string;
  try {
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      body: body.toString(),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
    html = await res.text();
  } finally {
    clearTimeout(timer);
  }
  const $ = cheerio.load(html);
  const out: SearchResult[] = [];
  $('.result').each((_i, el) => {
    if (out.length >= limit) return;
    const a = $(el).find('a.result__a').first();
    const href = a.attr('href') || '';
    // ddg 链接形如 //duckduckgo.com/l/?uddg=<encoded>&rut=...，提取真实 URL
    let url = href;
    const m = href.match(/[?&]uddg=([^&]+)/);
    if (m) url = decodeURIComponent(m[1]);
    if (isBlocked(url)) return;
    out.push({
      title: a.text().trim(),
      url,
      domain: domainOf(url),
      snippet: $(el).find('.result__snippet').first().text().trim(),
      provider: 'duckduckgo',
    });
  });
  return out;
}

/** Google Custom Search JSON API（需 key+cx） */
export async function searchGoogleCse(query: string, limit = 10): Promise<SearchResult[]> {
  const { googleCseKey, googleCseId } = config.search;
  if (!googleCseKey || !googleCseId) throw new Error('未配置 GOOGLE_CSE_KEY / GOOGLE_CSE_ID');
  const data = await fetchJson(
    `https://www.googleapis.com/customsearch/v1?key=${googleCseKey}&cx=${googleCseId}&q=${encodeURIComponent(query)}&num=${Math.min(limit, 10)}`,
  );
  return (data.items || [])
    .map((it: any) => ({ title: it.title, url: it.link, domain: domainOf(it.link), snippet: it.snippet || '', provider: 'google_cse' }))
    .filter((r: SearchResult) => !isBlocked(r.url))
    .slice(0, limit);
}

/** SerpAPI（需 key，代理 Google 结果） */
export async function searchSerpApi(query: string, limit = 10): Promise<SearchResult[]> {
  const { serpapiKey } = config.search;
  if (!serpapiKey) throw new Error('未配置 SERPAPI_KEY');
  const data = await fetchJson(
    `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&api_key=${serpapiKey}&num=${Math.min(limit, 10)}`,
  );
  return ((data.organic_results as any[]) || [])
    .map((r) => ({ title: r.title, url: r.link, domain: domainOf(r.link), snippet: r.snippet || '', provider: 'serpapi' }))
    .filter((r) => !isBlocked(r.url))
    .slice(0, limit);
}

/** Tavily 搜索（免费额度 1000 次/月，国内网络可达） */
export async function searchTavily(query: string, limit = 10): Promise<SearchResult[]> {
  const key = config.search.tavilyKey;
  if (!key) throw new Error('未配置 TAVILY_API_KEY');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  let data: any;
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query, max_results: limit, search_depth: 'basic' }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
    data = await res.json();
  } finally {
    clearTimeout(timer);
  }
  return ((data.results as any[]) || [])
    .map((r) => ({ title: r.title, url: r.url, domain: domainOf(r.url), snippet: r.content || '', provider: 'tavily' }))
    .filter((r) => !isBlocked(r.url))
    .slice(0, limit);
}

/**
 * 执行搜索；若首选源失败，按可用 key 级联降级到其他源（多层容错）
 */
export async function runSearch(query: string, limit = 10, provider?: string): Promise<SearchResult[]> {
  const chain: string[] = [provider || config.search.provider];
  // 级联顺序：有 key 的源依次兜底（tavily → serpapi → ddg）
  if (config.search.tavilyKey && !chain.includes('tavily')) chain.push('tavily');
  if (config.search.serpapiKey && !chain.includes('serpapi')) chain.push('serpapi');
  if (!chain.includes('duckduckgo')) chain.push('duckduckgo');
  let lastErr: unknown;
  for (const p of chain) {
    try {
      const results = await (p === 'google_cse' ? searchGoogleCse(query, limit)
        : p === 'serpapi' ? searchSerpApi(query, limit)
        : p === 'tavily' ? searchTavily(query, limit)
        : searchDuckDuckGo(query, limit));
      if (results.length) return results;
      lastErr = new Error(`${p} 无结果`);
    } catch (e) {
      lastErr = e;
      console.warn(`[search] ${p} 失败: ${(e as Error).message}，尝试下一个源`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('所有搜索源均失败');
}
