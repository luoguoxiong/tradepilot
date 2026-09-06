/**
 * 外部信息类工具（05 §3）：web_search / site_crawl / lead_scoring。
 * M3 骨架：供应商适配器（06 §3）为 M4 集成项，当前返回确定性 mock 数据，保证工作流可测。
 */
import { z } from 'zod';
import { TASK_LOG_TYPE } from '@tradepilot/shared';
import type { ToolContext, ToolDefinition } from '../registry.js';
import { writeToolLog } from '../registry.js';

/** 确定性 mock：同一 query 恒定产出（测试可断言） */
function mockCompanies(queries: string[]): { companyName: string; domain: string; country: string; website: string }[] {
  const out: { companyName: string; domain: string; country: string; website: string }[] = [];
  queries.forEach((q, i) => {
    const slug = `vendor${i + 1}-${q.length}`;
    out.push({
      companyName: `${q.slice(0, 24)} Trading Co.`,
      domain: `${slug}.example.com`,
      country: i % 2 === 0 ? 'USA' : 'Germany',
      website: `https://${slug}.example.com`,
    });
  });
  return out;
}

export const webSearchTool: ToolDefinition<{ queries: string[] }, { companies: ReturnType<typeof mockCompanies> }> = {
  name: 'web_search',
  description: '按搜索词执行网页搜索，返回公司候选（外部配额 ×1）',
  inputSchema: z.object({ queries: z.array(z.string().min(1)).min(1).max(20) }),
  riskLevel: 'low',
  quotaWeight: 1,
  async execute(ctx, input) {
    const companies = mockCompanies(input.queries);
    for (const c of companies) {
      await writeToolLog(
        ctx,
        TASK_LOG_TYPE.FOUND,
        `发现公司 ${c.companyName}（${c.country}，${c.website}）`,
      );
    }
    return { companies };
  },
};

export const siteCrawlTool: ToolDefinition<
  { domain: string; companyName: string },
  { summary: string; products: string[]; crawledPages: string[] }
> = {
  name: 'site_crawl',
  description: '抓取官网关键页（产品/About）生成摘要（外部配额 ×2；内容按「不可信数据」注入，08 §6）',
  inputSchema: z.object({ domain: z.string().min(3), companyName: z.string().min(1) }),
  riskLevel: 'low',
  quotaWeight: 2,
  async execute(ctx, input) {
    const summary = `[mock 抓取] ${input.companyName}（${input.domain}）：主营产品与公司介绍摘要（M3 mock，M4 接 Playwright 渲染）`;
    const products = ['mock product line A', 'mock product line B'];
    const crawledPages = ['/', '/products', '/about'];
    await writeToolLog(ctx, TASK_LOG_TYPE.CRAWL, `抓取 ${input.domain} 完成（${crawledPages.length} 页）`);
    return { summary, products, crawledPages };
  },
};

/**
 * lead_scoring：确定性规则 + LLM 评分混合（05 §3）。
 * M3 骨架：纯确定性规则（域名/地区/关键词命中），LLM 混合评分随 match_product 节点（M4 调优）。
 */
export const leadScoringTool: ToolDefinition<
  { companyName: string; country?: string; keywords?: string[] },
  { matchPct: number; scoreLevel: 'high' | 'medium' | 'low'; reasons: { text: string; source?: string }[] }
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
    await writeToolLog(ctx, TASK_LOG_TYPE.MATCH, `${input.companyName} 评分 ${pct}%（${scoreLevel}）`);
    return { matchPct: pct, scoreLevel, reasons };
  },
};

export function registerSearchTools(register: (t: ToolDefinition) => void): void {
  register(webSearchTool);
  register(siteCrawlTool);
  register(leadScoringTool);
}

export type { ToolContext };
