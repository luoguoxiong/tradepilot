import '../polyfill.js'; // Node18 File polyfill，cheerio 依赖
import * as cheerio from 'cheerio';
import { config } from '../config.js';
import type { ScrapedPage } from '../prompts/analysis.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const SUBPAGE_KEYWORDS: { label: string; re: RegExp }[] = [
  { label: 'about', re: /about|company|ueber|uber-uns|nosotros|pro-nas/i },
  { label: 'products', re: /product|catalog|collection|shop|range|sortiment|category/i },
  { label: 'contact', re: /contact|kontakt|contacto|imprint|impressum/i },
];

export interface RuleContact { emails: string[]; persons: string[]; has_form: boolean }

export interface ScrapeResult {
  pages: ScrapedPage[];
  contact: RuleContact;      // 规则抽取（红线：联系方式不走 LLM）
  allText: string;           // 规则抽取邮箱用全文
  ok: boolean;               // 是否成功抓到至少一页
  failReason?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(url: string): Promise<{ html: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.scrape.timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('html')) throw new Error(`非 HTML 页面: ${ct}`);
    return { html: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/** HTML → 纯文本（去 script/style/nav/footer 噪音） */
function extractText(html: string): { text: string; hasForm: boolean } {
  const $ = cheerio.load(html);
  const hasForm = $('form').length > 0 || /mailto:/i.test(html);
  $('script,style,noscript,svg,iframe,nav,footer,header').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  return { text, hasForm };
}

/** 抓取官网：首页 + About/Products/Contact 子页（上限 SCRAPED_PAGE_LIMIT），页面间礼貌延迟 */
export async function scrapeSite(startUrl: string): Promise<ScrapeResult> {
  const pages: ScrapedPage[] = [];
  const contact: RuleContact = { emails: [], persons: [], has_form: false };
  let allText = '';
  const base = new URL(startUrl);
  let homeHtml = '';

  // 1) 首页
  try {
    const { html } = await fetchPage(startUrl);
    homeHtml = html;
    const { text, hasForm } = extractText(html);
    contact.has_form = hasForm;
    allText += ' ' + text;
    pages.push({ label: 'home', url: startUrl, text, fetchedAt: new Date().toISOString() });
  } catch (e) {
    return {
      pages: [], contact, allText: '', ok: false,
      failReason: `首页抓取失败: ${(e as Error).message}${/aborted/i.test((e as Error).message) ? '（超时）' : ''}`,
    };
  }

  // 2) 从首页发现子页
  const $home = cheerio.load(homeHtml);
  const found = new Map<string, string>(); // label -> url
  $home('a[href]').each((_, el) => {
    if (found.size >= config.scrape.pageLimit - 1) return;
    const href = $home(el).attr('href') || '';
    const hit = SUBPAGE_KEYWORDS.find((k) => k.re.test(href));
    if (!hit || found.has(hit.label)) return;
    try {
      const u = new URL(href, base);
      if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) return; // 只跟站内
      found.set(hit.label, u.toString().split('#')[0]);
    } catch { /* 忽略非法链接 */ }
  });

  for (const [label, url] of found) {
    if (pages.length >= config.scrape.pageLimit) break;
    await sleep(config.scrape.pageDelayMs);
    try {
      const { html } = await fetchPage(url);
      const { text, hasForm } = extractText(html);
      if (hasForm) contact.has_form = true;
      allText += ' ' + text;
      pages.push({ label, url, text, fetchedAt: new Date().toISOString() });
    } catch (e) {
      pages.push({ label, url, text: '', fetchedAt: new Date().toISOString(), error: (e as Error).message });
    }
  }

  // 3) 规则抽取联系方式（邮箱 + 联系人姓名启发式）
  const emailRe = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  contact.emails = [...new Set((allText.match(emailRe) || []).map((e) => e.toLowerCase()))]
    .filter((e) => !/\.(png|jpg|jpeg|gif|webp)$/i.test(e))
    .slice(0, 5);
  // 姓名紧邻职位词（前向断言），避免匹配到 "Contact Max" 这类前缀错位
  const personRe = /\b([A-Z][a-z]+ [A-Z][a-z]+)[\s,-]*(?=(?:Head of|Purchasing|Procurement|Sourcing|Buyer|Sales Manager|CEO|Founder|Managing Director))/g;
  let pm: RegExpExecArray | null;
  while ((pm = personRe.exec(allText)) && contact.persons.length < 3) contact.persons.push(pm[1]);

  return { pages, contact, allText, ok: pages.some((p) => !p.error && p.text) };
}
