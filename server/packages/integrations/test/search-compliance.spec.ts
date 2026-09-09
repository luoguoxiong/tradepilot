import { describe, expect, it, vi } from 'vitest';
import {
  HttpSearchProvider,
  isExcludedDomain,
  robotsAllows,
  PerHostRateLimiter,
} from '../src/search/index.js';

/**
 * 抓取合规基元单测（08 §7 获客与数据合规，M4 C8）：
 * - robots.txt 尊重：UA 组 / * 组回落 / 最长前缀匹配 / allow 平长优先 / 空 Disallow 全放行 / 无文件允许；
 * - excludeDomains 硬过滤：host 归一 + 子域匹配；
 * - 单站限速：同 host 两次 acquire 间隔 ≥ minIntervalMs，跨 host 不互斥。
 * 无外部依赖（纯逻辑）。
 */

const ROBOTS = `
User-agent: *
Disallow: /private/
Allow: /private/public
Crawl-delay: 5

User-agent: BadBot
Disallow: /
`;

describe('robots.txt 放行判定（08 §7）', () => {
  it('* 组 disallow 前缀命中 → 拒绝', () => {
    expect(robotsAllows(ROBOTS, '/private/secret')).toBe(false);
    expect(robotsAllows(ROBOTS, '/private/secret?a=1')).toBe(false);
  });

  it('allow 与 disallow 前缀均命中 → 最长者胜（/private/public 放行）', () => {
    expect(robotsAllows(ROBOTS, '/private/public/page')).toBe(true);
  });

  it('无规则命中 → 允许', () => {
    expect(robotsAllows(ROBOTS, '/products')).toBe(true);
    expect(robotsAllows(ROBOTS, '/about')).toBe(true);
  });

  it('未命中 UA 组 → 回落 * 组（TradePilotBot 无专属组）', () => {
    expect(robotsAllows(ROBOTS, '/private/x', 'tradepilotbot/1.0')).toBe(false);
  });

  it('命中专属 UA 组 → 不回落 * 组（BadBot 全拒）', () => {
    expect(robotsAllows(ROBOTS, '/products', 'badbot')).toBe(false);
  });

  it('空 Disallow（disallow: 空值）= 全放行', () => {
    expect(robotsAllows('User-agent: *\nDisallow:\n', '/anything')).toBe(true);
  });

  it('无 robots 内容 / 无可用组 → 允许（获取失败视为允许的兜底语义）', () => {
    expect(robotsAllows('', '/x')).toBe(true);
    expect(robotsAllows('not-a-directive line\n', '/x')).toBe(true);
  });
});

describe('excludeDomains 硬过滤（08 §7）', () => {
  it('精确域名与子域均剔除，www 归一', () => {
    const ex = ['bad.example.com'];
    expect(isExcludedDomain('https://bad.example.com/a', ex)).toBe(true);
    expect(isExcludedDomain('https://www.bad.example.com/a', ex)).toBe(true);
    expect(isExcludedDomain('https://sub.bad.example.com/', ex)).toBe(true);
  });

  it('后缀相似但非子域 → 不剔除（防 notbad.example.com 误杀）', () => {
    expect(isExcludedDomain('https://notbad.example.com/', ['bad.example.com'])).toBe(false);
  });

  it('空过滤列表 / 非法 URL → 不剔除', () => {
    expect(isExcludedDomain('https://ok.com/', [])).toBe(false);
    expect(isExcludedDomain('::::not-a-url', ['bad.com'])).toBe(false);
  });
});

describe('单站限速 PerHostRateLimiter（08 §7）', () => {
  it('同 host 二次 acquire 等待最小间隔', async () => {
    const limiter = new PerHostRateLimiter(30);
    const t0 = Date.now();
    await limiter.acquire('h1');
    await limiter.acquire('h1');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
  });

  it('跨 host 不互斥', async () => {
    const limiter = new PerHostRateLimiter(200);
    const t0 = Date.now();
    await limiter.acquire('a.com');
    await limiter.acquire('b.com');
    expect(Date.now() - t0).toBeLessThan(150);
  });

  it('minIntervalMs<=0 直接放行', async () => {
    const limiter = new PerHostRateLimiter(0);
    const t0 = Date.now();
    await limiter.acquire('h');
    await limiter.acquire('h');
    expect(Date.now() - t0).toBeLessThan(25);
  });
});

describe('HttpSearchProvider 合规装配', () => {
  it('webSearch 剔除 excludeDomains 命中项', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          organic: [
            { title: 'A', link: 'https://good.com/a', snippet: 's' },
            { title: 'B', link: 'https://www.bad.com/b', snippet: 's' },
            { title: 'C', link: 'https://sub.bad.com/c', snippet: 's' },
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      const provider = new HttpSearchProvider({
        baseUrl: 'https://api.test',
        apiKey: 'k',
        excludeDomains: ['bad.com', 'sub.bad.com'],
      });
      const hits = await provider.webSearch('q');
      expect(hits.map((h) => h.url)).toEqual(['https://good.com/a']);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
