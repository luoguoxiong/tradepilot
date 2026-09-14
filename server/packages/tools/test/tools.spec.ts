/**
 * @tradepilot/tools 单测（补齐 §7.2 高优先级缺口：本包此前 0 测试）。
 * 完整覆盖（可作为用例通过依据）：
 * - TC-LEAD-09 决策影响力确定性映射（90/75/40/null，不猜测）
 * - TC-LEAD-10 抓站失败降级（单站不可达不中断任务）
 * 部分覆盖：
 * - TC-NFR-36 仅覆盖「空 query → noResult」降级分支；「知识库为空 → 显式提示补充资料」需真实 Embedding
 * - TC-TASK-15 幂等：工具层 SET NX 抢占（补充既有 delayed-reconciler 幂等证据）
 * 补充覆盖（当前用例集无对应编号）：web_search 轮次换词、外发内容合规基线（08 §6 email_send 唯一出口）、
 * 工具校验链（员工白名单 40301 / 入参 40001 / 外部额度 42901，按 org 时区日界分片）。
 *
 * 依赖（db/redis/搜索供应商）均以最小 fake 注入，不依赖 docker 与外部凭据。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Tx } from '@tradepilot/db';
import type { BufferedTaskEvent, ToolContext, ToolDefinition } from '../src/index.js';
import {
  ToolRegistry,
  assertEmailContentCompliance,
  checkEmailContentCompliance,
  mapDecisionInfluence,
  resetEmailCompliance,
  searchKnowledgeChunks,
  setEmailComplianceHook,
  toolIdempotencyKey,
  withIdempotency,
} from '../src/index.js';
import { leadScoringTool, siteCrawlTool, webSearchTool } from '../src/builtin/search-tools.js';
import { crmWriteTool } from '../src/builtin/crm-tools.js';
import { setSearchProviderFactory } from '@tradepilot/integrations';

/** 最小 fake 事务：满足工具节点的 insert/select 链（org 时区读取回落默认） */
function fakeTx(orgRows: { timezone?: string | null }[] = []): Tx {
  return {
    insert: () => ({ values: async () => undefined }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => orgRows }) }) }),
    execute: async () => undefined,
  } as unknown as Tx;
}

/** 最小 fake Redis：仅实现令牌桶（INCRBY/EXPIRE）与幂等抢占（SET NX EX） */
function fakeRedis() {
  const counters = new Map<string, number>();
  return {
    counters,
    incrby: async (key: string, weight: number) => {
      const next = (counters.get(key) ?? 0) + weight;
      counters.set(key, next);
      return next;
    },
    expire: async () => 1,
    set: async (key: string) => {
      if (counters.has(`lock:${key}`)) {
        return null;
      }
      counters.set(`lock:${key}`, 1);
      return 'OK';
    },
  };
}

function makeCtx(over: { redis?: unknown; bag?: Map<string, unknown> } = {}): ToolContext {
  const events: BufferedTaskEvent[] = [];
  return {
    orgId: 'org_test',
    taskId: 'task_test',
    employeeId: 'emp_test',
    nodeId: 'node_test',
    taskType: 'lead_hunting',
    tx: fakeTx(),
    redis: (over.redis ?? fakeRedis()) as never,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    now: new Date('2026-09-14T02:00:00.000Z'),
    bag: over.bag ?? new Map<string, unknown>(),
    log: async () => 'tlog_test',
    emit: (e: BufferedTaskEvent) => events.push(e),
  } as unknown as ToolContext;
}

function tool(over: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'demo_tool',
    description: '单测工具',
    inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) } as never,
    riskLevel: 'low',
    async execute() {
      return { ok: true };
    },
    ...over,
  };
}

afterEach(() => {
  resetEmailCompliance();
  setSearchProviderFactory(() => {
    throw new Error('搜索供应商不可用（单测未注入）');
  });
});

describe('mapDecisionInfluence（04 §3.2 决策影响力确定性映射，TC-LEAD-09）', () => {
  it('90 = 采购决策层（Director/VP/Head/Chief/CPO + 采购职能词）', () => {
    expect(mapDecisionInfluence('Procurement Director')).toBe(90);
    expect(mapDecisionInfluence('VP of Sourcing')).toBe(90);
    expect(mapDecisionInfluence('Head of Purchasing')).toBe(90);
    expect(mapDecisionInfluence('Chief Procurement Officer')).toBe(90);
    expect(mapDecisionInfluence('VP, Global Buying')).toBe(90);
  });

  it('75 = 采购执行层（Purchasing/Sourcing/Procurement Manager、Buyer、Merchandiser）', () => {
    expect(mapDecisionInfluence('Purchasing Manager')).toBe(75);
    expect(mapDecisionInfluence('Senior Buyer')).toBe(75);
    expect(mapDecisionInfluence('Merchandiser')).toBe(75);
    expect(mapDecisionInfluence('Sourcing Manager')).toBe(75);
  });

  it('40 = 影响层（识别到但非采购职能）', () => {
    expect(mapDecisionInfluence('Quality Engineer')).toBe(40);
    expect(mapDecisionInfluence('R&D Manager')).toBe(40);
  });

  it('未命中 → null（不猜测）', () => {
    expect(mapDecisionInfluence('Office Manager')).toBeNull();
    expect(mapDecisionInfluence('')).toBeNull();
    expect(mapDecisionInfluence('Sales Representative')).toBeNull();
  });

  it('大小写不敏感，可复算', () => {
    expect(mapDecisionInfluence('purchasing DIRECTOR')).toBe(90);
    expect(mapDecisionInfluence('Purchasing Director')).toBe(
      mapDecisionInfluence('  purchasing   director '),
    );
  });
});

describe('ToolRegistry 校验链（05 §3 / Runtime §4.5）', () => {
  it('重复注册直接抛错（装配期失败，不静默覆盖）', () => {
    const registry = new ToolRegistry();
    registry.register(tool());
    expect(() => registry.register(tool())).toThrow(/重复注册/);
  });

  it('未注册工具 → 40401', () => {
    const registry = new ToolRegistry();
    expect(() => registry.get('nope')).toThrow(/未注册/);
    try {
      registry.get('nope');
    } catch (err) {
      expect((err as { code: number }).code).toBe(40401);
    }
  });

  it('校验链①：员工工具白名单外 → 40301', () => {
    const registry = new ToolRegistry();
    expect(() => registry.assertAllowed(tool({ name: 'email_send' }), ['web_search'])).toThrow(
      /未被授权/,
    );
    expect(() =>
      registry.assertAllowed(tool({ name: 'email_send' }), ['web_search', 'email_send']),
    ).not.toThrow();
  });

  it('校验链②：入参不合法 → 40001（AI 不可传越权字段）', () => {
    const registry = new ToolRegistry();
    const zod = {
      safeParse: () => ({ success: false, error: { issues: [{ message: 'ownerId 不允许' }] } }),
    };
    expect(() => registry.parseInput(tool({ inputSchema: zod as never }), {})).toThrow(
      /入参不合法/,
    );
    try {
      registry.parseInput(tool({ inputSchema: zod as never }), {});
    } catch (err) {
      expect((err as { code: number }).code).toBe(40001);
    }
  });

  it('校验链④：quotaWeight=0 不计外部配额', async () => {
    const registry = new ToolRegistry();
    const redis = fakeRedis();
    await registry.assertQuota(
      { orgId: 'org1', employeeId: 'emp1', redis: redis as never, now: new Date() },
      tool(),
      1,
    );
    expect(redis.counters.size).toBe(0);
  });

  it('校验链④：日额度耗尽 → 42901（按 org 时区日界分片）', async () => {
    const registry = new ToolRegistry();
    const redis = fakeRedis();
    const ctx = {
      orgId: 'org1',
      employeeId: 'emp1',
      redis: redis as never,
      now: new Date(),
      timezone: 'Asia/Shanghai',
    };
    const weighted = tool({ name: 'web_search', quotaWeight: 1 });
    await registry.assertQuota(ctx, weighted, 2);
    await registry.assertQuota(ctx, weighted, 2);
    await expect(registry.assertQuota(ctx, weighted, 2)).rejects.toMatchObject({ code: 42901 });
    expect([...redis.counters.keys()][0]).toMatch(/^quota:org1:emp1:\d{8}$/);
  });
});

describe('幂等（04 §5.2，TC-TASK-15 重复投递不重复执行）', () => {
  it('幂等键 = taskId + nodeId（+salt）', () => {
    expect(toolIdempotencyKey({ taskId: 't1', nodeId: 'n1' })).toBe('idem:t1:n1');
    expect(toolIdempotencyKey({ taskId: 't1', nodeId: 'n1' }, 'hash1')).toBe('idem:t1:n1:hash1');
  });

  it('首次执行 first=true，重复调用 first=false 且不执行 fn', async () => {
    const ctx = makeCtx();
    let calls = 0;
    const key = toolIdempotencyKey(ctx, 'send');
    const first = await withIdempotency(ctx, key, 60, async () => {
      calls += 1;
      return 'sent';
    });
    const second = await withIdempotency(ctx, key, 60, async () => {
      calls += 1;
      return 'sent';
    });
    expect(first).toEqual({ first: true, result: 'sent' });
    expect(second.first).toBe(false);
    expect(calls).toBe(1);
  });
});

describe('外发内容合规基线（08 §6，email_send 唯一出口）', () => {
  it('合法内容无 findings', async () => {
    expect(
      await checkEmailContentCompliance({ subject: 'Quotation', body: 'Hello\nworld' }),
    ).toEqual([]);
  });

  it('空主题/空正文被拦截', async () => {
    const findings = await checkEmailContentCompliance({ subject: '   ', body: '' });
    expect(findings.map((f) => f.code)).toEqual(
      expect.arrayContaining(['subject_empty', 'body_empty']),
    );
  });

  it('超长主题（>200）/ 正文（>20000）被拦截', async () => {
    expect(
      (await checkEmailContentCompliance({ subject: 'a'.repeat(201), body: 'b' })).map(
        (f) => f.code,
      ),
    ).toContain('subject_too_long');
    expect(
      (await checkEmailContentCompliance({ subject: 'a', body: 'b'.repeat(20_001) })).map(
        (f) => f.code,
      ),
    ).toContain('body_too_long');
  });

  it('控制字符被拦截（防注入/乱码外发）', async () => {
    expect(
      (await checkEmailContentCompliance({ subject: 'a b', body: 'x' })).map((f) => f.code),
    ).toContain('control_chars');
  });

  it('扩展钩子（org 敏感词）生效', async () => {
    setEmailComplianceHook((input) =>
      /guaranteed/.test(input.body.toLowerCase())
        ? [{ code: 'banned_keyword', detail: '禁止承诺性用语' }]
        : [],
    );
    expect(
      (await checkEmailContentCompliance({ subject: 'a', body: 'guaranteed quality' }))[0]?.code,
    ).toBe('banned_keyword');
    resetEmailCompliance();
    expect(await checkEmailContentCompliance({ subject: 'a', body: 'guaranteed quality' })).toEqual(
      [],
    );
  });

  it('assert 版本违规抛 42201（不静默外发）', async () => {
    await expect(assertEmailContentCompliance({ subject: '', body: '' })).rejects.toMatchObject({
      code: 42201,
    });
  });
});

describe('knowledge_search 无结果红线（TC-NFR-36 降级分支）', () => {
  it('空 query 短路：noResult=true，不产生无意义召回（下游须显式提示并禁止编造）', async () => {
    const res = await searchKnowledgeChunks(fakeTx(), 'org_test', { query: '   ' });
    expect(res).toEqual({ results: [], noResult: true });
  });
});

describe('lead_scoring 确定性评分（Insight Schema 可解释）', () => {
  it('关键词与地区命中累加，上限 97，reasons 逐条可溯源', async () => {
    const res = await leadScoringTool.execute(makeCtx(), {
      companyName: 'Acme',
      country: 'US',
      keywords: ['led', 'lighting', 'oem'],
    });
    expect(res.matchPct).toBe(90);
    expect(res.scoreLevel).toBe('high');
    expect(res.reasons.length).toBeGreaterThanOrEqual(3);
    expect(res.reasons.every((r) => typeof r.text === 'string' && r.text.length > 0)).toBe(true);
  });

  it('无命中信号时为 low（55 < 60），不虚构高分', async () => {
    const res = await leadScoringTool.execute(makeCtx(), { companyName: 'Acme' });
    expect(res.matchPct).toBe(55);
    expect(res.scoreLevel).toBe('low');
  });
});

describe('site_crawl 降级（TC-LEAD-10 单站不可达不中断任务）', () => {
  it('抓取失败（WAF 403/超时/DNS）→ reachable=false + note 原因，不向外抛异常', async () => {
    setSearchProviderFactory(() => ({
      async webSearch() {
        return [];
      },
      async crawlSite() {
        throw new Error('403 Forbidden（WAF）');
      },
    }));
    const res = await siteCrawlTool.execute(makeCtx(), {
      domain: 'blocked.com',
      companyName: 'Blocked',
    });
    expect(res.reachable).toBe(false);
    expect(res.note).toContain('403');
    expect(res.products).toEqual([]);
  });

  it('成功抓取 → reachable=true 且带摘要', async () => {
    setSearchProviderFactory(() => ({
      async webSearch() {
        return [];
      },
      async crawlSite() {
        return { summary: 'LED 制造商', products: ['Panel Light'], crawledPages: ['/'] };
      },
    }));
    const res = await siteCrawlTool.execute(makeCtx(), { domain: 'acme.com', companyName: 'Acme' });
    expect(res.reachable).toBe(true);
    expect(res.summary).toBe('LED 制造商');
    expect(res.crawledPages).toEqual(['/']);
  });

  it('边界：供应商未装配（解析失败）直接失败，不降级为「空摘要」（无 mock 兜底）', async () => {
    setSearchProviderFactory(() => {
      throw new Error('Search provider 未配置');
    });
    await expect(
      siteCrawlTool.execute(makeCtx(), { domain: 'acme.com', companyName: 'Acme' }),
    ).rejects.toThrow(/Search provider 未配置/);
  });
});

describe('web_search 轮次换词（TC-LEAD-04）', () => {
  it('逐轮轮换搜索词（第 N 轮取第 N 条 query），并累计轮次', async () => {
    const queries: string[] = [];
    setSearchProviderFactory(() => ({
      async webSearch(query: string) {
        queries.push(query);
        return [{ title: 'Acme Inc - LED Lighting', url: 'https://acme.com' }];
      },
      async crawlSite() {
        return { summary: '', products: [], crawledPages: [] };
      },
    }));
    const bag = new Map<string, unknown>();
    const first = await webSearchTool.execute(makeCtx({ bag }), { queries: ['q1', 'q2'] });
    const second = await webSearchTool.execute(makeCtx({ bag }), { queries: ['q1', 'q2'] });
    expect(queries).toEqual(['q1', 'q2']);
    expect(first.companies[0]?.domain).toBe('acme.com');
    expect(second.companies[0]?.companyName).toBe('Acme Inc');
  });
});

describe('crm_write 跨任务去重合并取更高分（TC-LEAD-06，03 §3.6）', () => {
  /** crm_write 专用 fake tx：捕获 update/insert，select 命中既有 lead（org+domain 查重） */
  function crmWriteTx(existing: { id: string; matchPct: number }[]) {
    const updates: Record<string, unknown>[] = [];
    const inserts: Record<string, unknown>[] = [];
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => existing,
          }),
        }),
      }),
      update: () => ({
        set: (vals: Record<string, unknown>) => {
          updates.push(vals);
          return { where: async () => undefined };
        },
      }),
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          inserts.push(v);
          // 兼容两种链式：await insert().values(...) 与 insert().values(...).returning(...)
          const q = {
            returning: async () => [{ id: v['id'] }],
            then: (res: unknown, rej: unknown) =>
              Promise.resolve([{ id: v['id'] }]).then(res as never, rej as never),
          };
          return q;
        },
      }),
      execute: async () => undefined,
    } as unknown as Tx;
    return { tx, updates, inserts };
  }

  const REASONS = [{ text: '产品高度匹配', evidence: '官网产品页', source: 'site_crawl' }];

  function lead(over: { matchPct: number; scoreLevel: 'high' | 'medium' | 'low'; domain: string }) {
    return {
      companyName: 'Acme',
      country: 'US',
      domain: over.domain,
      matchPct: over.matchPct,
      scoreLevel: over.scoreLevel,
      reasons: REASONS,
    };
  }

  it('跨任务命中同域名且新分更高 → 合并更新取更高分，不新建记录', async () => {
    const { tx, updates, inserts } = crmWriteTx([{ id: 'lead_exist', matchPct: 60 }]);
    const ctx = makeCtx();
    (ctx as { tx: Tx }).tx = tx;
    const res = await crmWriteTool.execute(ctx, {
      leads: [lead({ matchPct: 85, scoreLevel: 'high', domain: 'acme.com' })],
    });
    expect(res).toEqual({ saved: 0, merged: 1, leadIds: ['lead_exist'] });
    // 取更高分：matchPct/scoreLevel/insight 以新分覆写
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ matchPct: 85, scoreLevel: 'high' });
    expect((updates[0]['insight'] as { value: number }).value).toBe(85);
    // 未新建 lead 行（唯一 insert 为收尾的 ai_task_log）
    expect(inserts.every((v) => typeof v['content'] === 'string')).toBe(true);
  });

  it('新分不高于既有分 → 仅合并计数，不覆写分数', async () => {
    for (const matchPct of [50, 60]) {
      const { tx, updates } = crmWriteTx([{ id: 'lead_exist', matchPct: 60 }]);
      const ctx = makeCtx();
      (ctx as { tx: Tx }).tx = tx;
      const res = await crmWriteTool.execute(ctx, {
        leads: [lead({ matchPct, scoreLevel: 'medium', domain: 'acme.com' })],
      });
      expect(res).toEqual({ saved: 0, merged: 1, leadIds: ['lead_exist'] });
      expect(updates).toHaveLength(0);
    }
  });

  it('发现池无同域名 → 新建 lead（inCrm=false + 域名归一化 + 联系人随迁）', async () => {
    const { tx, updates, inserts } = crmWriteTx([]);
    const ctx = makeCtx();
    (ctx as { tx: Tx }).tx = tx;
    const res = await crmWriteTool.execute(ctx, {
      leads: [
        {
          ...lead({ matchPct: 70, scoreLevel: 'medium', domain: 'acme.com' }),
          contacts: [{ name: 'Tom', title: 'Buyer', email: 'Tom@Acme.com' }],
        },
      ],
    });
    expect(res.saved).toBe(1);
    expect(res.merged).toBe(0);
    expect(updates).toHaveLength(0);
    const leadRow = inserts.find((v) => v['companyDomain'] === 'acme.com');
    expect(leadRow).toMatchObject({ companyName: 'Acme', inCrm: false, matchPct: 70 });
    expect(leadRow && typeof leadRow['id'] === 'string' && res.leadIds[0]).toBeTruthy();
    // 联系人邮箱小写归一 + 决策影响力缺省 null
    const contactRow = inserts.find((v) => v['name'] === 'Tom');
    expect(contactRow).toMatchObject({ email: 'tom@acme.com', source: 'ai_discovery' });
    expect(contactRow && contactRow['decisionInfluencePct']).toBeNull();
  });
});
