/**
 * 外部信息类工具（05 §3）：web_search / site_crawl / find_contact / lookup_contact / lead_scoring。
 * M4-1：lead_hunting 图真实链路落地——搜索轮次换词、联系人发现与公开渠道查找、
 * 决策影响力 90/75/40 档确定性映射（04 需求 §3.2）。
 * M4-6：web_search/site_crawl 接供应商适配器（06 §3，@tradepilot/integrations getSearchProvider；
 * worker 启动时 setSearchProviderFactory 按 org 注入「AI 模型配置」选用的供应商，未配置明确报错）
 * + org 级日额度令牌桶。
 * find_contact/lookup_contact：真实联系人与联系方式供应商属 P1 扩展，当前一律不产编造数据（返回空并留痕）。
 */
import { z } from 'zod';
import { TASK_LOG_TYPE, type CompanyLead, type LeadContact } from '@tradepilot/shared';
import { getSearchProvider } from '@tradepilot/integrations';
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

/** 跨轮累积（LastValue 通道无 reducer，bag 承载；assemble_leads 消费） */
function bagContacts(ctx: ToolContext): LeadContact[] {
  return (ctx.bag.get('contactsAll') as LeadContact[] | undefined) ?? [];
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
 * find_contact（LangGraph 00 §2.3，M4-1 工具化）：发现潜在采购负责人（职位/部门匹配）。
 * 真实联系人供应商属 P1 扩展；当前不编造联系人或联系方式（08 §6 数据可信红线），
 * 返回空并留痕。职衔排序/决策影响力映射规则见 `mapDecisionInfluence`（P1 接入后复用）。
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
  async execute(ctx, input) {
    // 真实联系人供应商属 P1 扩展：不编造联系人或联系方式（08 §6 数据可信红线），返回空并留痕。
    await writeToolLog(
      ctx,
      TASK_LOG_TYPE.CONTACT,
      `联系人数据源未接入，跳过 ${input.companyName} 的联系人发现`,
    );
    return { contacts: [] };
  },
};

/**
 * lookup_contact（LangGraph 00 §2.3）：仅查找公开商务渠道联系方式（GDPR/CCPA 合规边界，03 §4）。
 * 真实联系方式供应商随 P1 接入；当前不合成公开邮箱，仅返回已归并联系人并留痕。外部配额 ×1。
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
    // 真实联系方式供应商属 P1 扩展：不合成公开邮箱（08 §6 数据可信红线）
    await writeToolLog(
      ctx,
      TASK_LOG_TYPE.LOOKUP,
      `联系方式数据源未接入，跳过 ${input.companyName}`,
    );
    return {
      contacts: all.filter((c) => entityKey(c.companyName, c.domain) === target),
      lookedUp: 0,
    };
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
