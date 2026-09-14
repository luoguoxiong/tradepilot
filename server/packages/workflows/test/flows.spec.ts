/**
 * @tradepilot/workflows 单测（补齐 §7.2 高优先级缺口：本包此前 0 测试）。
 * 完整覆盖（可作为用例通过依据）：
 * - TC-LEAD-04 任务级额度约束（目标数/轮次守护 → save/continue）
 * - TC-LEAD-05 三级去重-任务内（归一化域名命中 → duplicate，跳过抓站与评分）
 * - TC-LEAD-07 评分确定性映射（以 matchPct 为准，不看 LLM 回显；自定义阈值）
 * - TC-LEAD-08 低分不进联系人发现（record_score → low 分支）
 * 部分覆盖（仅契约/提示词层，不足以判定用例通过）：
 * - TC-LEAD-02 缺失字段留空不脑补（parsedGoal schema + 提示词红线，真实 LLM 行为未验证）
 * - TC-LEAD-06 跨任务去重：仅覆盖「命中 → duplicate 不新建」，「合并更新取更高分」未覆盖
 * - TC-INB-04 / TC-APV-15：draftReply grounded+missingInfo、confidence 0~1、reasons Insight Schema 契约
 * - TC-XMOD-01：repliedSinceLast → outputs 转人工交接契约（暂停动作本身未覆盖）
 * 补充覆盖（当前用例集无对应编号）：SOP ↔ flow/tool/prompt/schema 注册表交叉一致性、提示词红线文案。
 *
 * 说明：flow 节点的 DB 访问一律经 withOrg（db.transaction），此处以最小 fake db 注入，
 * 不依赖 docker / 真实凭据，属纯单测（*.spec.ts 但无需外部中间件）。
 */
import { describe, expect, it } from 'vitest';
import type { Db } from '@tradepilot/db';
import type { FlowNodeFn, TaskRunContext } from '@tradepilot/runtime';
import type { CompanyLead, LeadContact, LeadScore } from '@tradepilot/shared';
import { createToolRegistry } from '@tradepilot/tools';
import {
  buildWorkflowOutputs,
  createFlowRegistry,
  createOutputSchemaRegistry,
  createPromptRegistry,
  mapScoreLevel,
  WORKFLOW_SOP_DEFINITIONS,
  workflowSopProvider,
} from '../src/index.js';

/** 发现池已存在的 lead（dedup_check 的 DB 查重来源） */
type ExistingLead = { companyName: string; companyDomain: string | null };

/** 最小 fake db：仅需满足 withOrg（transaction）+ dedup_check 的 select 链 */
function fakeDb(existing: ExistingLead[] = []): Db {
  const tx = {
    execute: async () => undefined,
    select: () => ({
      from: () => ({
        where: async () => existing,
      }),
    }),
    insert: () => ({ values: async () => undefined }),
  };
  return {
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(tx),
  } as unknown as Db;
}

const NOW = new Date('2026-09-14T02:00:00.000Z');

function makeCtx(
  opts: {
    input?: Record<string, unknown>;
    existing?: ExistingLead[];
    bag?: Map<string, unknown>;
  } = {},
): TaskRunContext {
  return {
    orgId: 'org_test',
    taskId: 'task_test',
    employeeId: 'emp_test',
    nodeId: 'node_test',
    taskType: 'lead_hunting',
    redis: {} as never,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    now: NOW,
    bag: opts.bag ?? new Map<string, unknown>(),
    events: [],
    db: fakeDb(opts.existing ?? []),
    employee: {
      id: 'emp_test',
      orgId: 'org_test',
      role: 'lead_hunter',
      name: 'AI 获客专员',
      tools: [],
      knowledgeScope: [],
      approvalPolicy: {},
      memoryConfig: null,
      externalCallDailyLimit: 200,
    },
    org: {
      id: 'org_test',
      timezone: 'Asia/Shanghai',
      sendRules: null,
      autoApproveTypes: [],
      approvalTtlMsByType: {},
    },
    task: { id: 'task_test', title: '单测任务', input: opts.input ?? {} },
    progressPct: 0,
    currentStep: '',
  } as unknown as TaskRunContext;
}

function lead(companyName: string, domain: string): CompanyLead & { source: string } {
  return {
    companyName,
    domain,
    website: `https://${domain}`,
    country: 'US',
    source: 'web_search',
  };
}

function score(over: Partial<LeadScore>): LeadScore {
  return {
    companyName: 'Acme',
    matchPct: 90,
    scoreLevel: 'high',
    reasons: [{ text: '产品高度匹配', evidence: '官网产品页', source: 'site_crawl' }],
    ...over,
  };
}

const registry = createFlowRegistry();
const node = (route: string): FlowNodeFn => registry.get(route) as FlowNodeFn;

describe('mapScoreLevel（03 §3.5 评分确定性映射，TC-LEAD-07）', () => {
  it('默认分档：High ≥ 85、Medium ≥ 60、其余 Low', () => {
    expect(mapScoreLevel(100)).toBe('high');
    expect(mapScoreLevel(85)).toBe('high');
    expect(mapScoreLevel(84)).toBe('medium');
    expect(mapScoreLevel(60)).toBe('medium');
    expect(mapScoreLevel(59)).toBe('low');
    expect(mapScoreLevel(0)).toBe('low');
  });

  it('自定义 matchThresholds 生效（员工高级设置）', () => {
    expect(mapScoreLevel(70, { high: 85, medium: 60 })).toBe('medium');
    expect(mapScoreLevel(70, { high: 90, medium: 70 })).toBe('medium');
    expect(mapScoreLevel(70, { high: 90, medium: 75 })).toBe('low');
  });

  it('阈值缺省字段回落默认（仅给 high 时 medium 仍为 60）', () => {
    expect(mapScoreLevel(65, { high: 90 })).toBe('medium');
    expect(mapScoreLevel(88, { medium: 95 })).toBe('high');
  });
});

describe('dedup_check（03 §3.6 三级去重，TC-LEAD-05 / TC-LEAD-06）', () => {
  it('首次发现：branch=new 且 discovered 落单条候选', async () => {
    const ctx = makeCtx();
    const res = await node('dedup_check')(
      { searchResult: { companies: [lead('Acme', 'acme.com')] } },
      ctx,
    );
    expect(res.branch).toBe('new');
    expect((res.patch?.['discovered'] as CompanyLead[])[0]?.domain).toBe('acme.com');
  });

  it('任务内去重：同一公司（同域名）第二轮直接 duplicate，不再评分', async () => {
    const ctx = makeCtx();
    const companies = [lead('Acme', 'acme.com')];
    await node('dedup_check')({ searchResult: { companies } }, ctx);
    const second = await node('dedup_check')({ searchResult: { companies } }, ctx);
    expect(second.branch).toBe('duplicate');
    expect(second.patch?.['discovered']).toBeUndefined();
  });

  it('域名归一：去协议/去 www/小写后视为同一家公司', async () => {
    const ctx = makeCtx();
    await node('dedup_check')(
      { searchResult: { companies: [lead('Acme', 'https://WWW.Acme.com')] } },
      ctx,
    );
    const second = await node('dedup_check')(
      { searchResult: { companies: [lead('Acme Inc', 'acme.com')] } },
      ctx,
    );
    expect(second.branch).toBe('duplicate');
  });

  it('跨任务去重：发现池已存在同域名 → duplicate（不新建记录）', async () => {
    const ctx = makeCtx({
      existing: [{ companyName: 'Acme', companyDomain: 'acme.com' }],
    });
    const res = await node('dedup_check')(
      { searchResult: { companies: [lead('Acme', 'acme.com')] } },
      ctx,
    );
    expect(res.branch).toBe('duplicate');
  });

  it('跨任务去重：发现池已存在同名（无域名）→ duplicate（名称兜底）', async () => {
    const ctx = makeCtx({ existing: [{ companyName: 'Acme', companyDomain: null }] });
    const res = await node('dedup_check')(
      { searchResult: { companies: [lead('ACME', null as unknown as string)] } },
      ctx,
    );
    expect(res.branch).toBe('duplicate');
  });

  it('excludeDomains 硬过滤（确定性，不进 AI 评分）', async () => {
    const ctx = makeCtx({
      input: { advancedSettings: { excludeDomains: ['spam.com', 'WWW.Blocked.com'] } },
    });
    const blocked = await node('dedup_check')(
      { searchResult: { companies: [lead('Spam', 'spam.com')] } },
      ctx,
    );
    expect(blocked.branch).toBe('duplicate');
    const blockedWww = await node('dedup_check')(
      { searchResult: { companies: [lead('Blocked', 'blocked.com')] } },
      ctx,
    );
    expect(blockedWww.branch).toBe('duplicate');
  });

  it('companySizeRange 硬过滤：员工数区间外的候选被排除', async () => {
    const ctx = makeCtx({
      input: { advancedSettings: { companySizeRange: { min: 50, max: 500 } } },
    });
    const tooSmall = await node('dedup_check')(
      {
        searchResult: {
          companies: [{ ...lead('Tiny', 'tiny.com'), employeeCount: 10 }],
        },
      },
      ctx,
    );
    expect(tooSmall.branch).toBe('duplicate');
    const inRange = await node('dedup_check')(
      {
        searchResult: {
          companies: [{ ...lead('Fit', 'fit.com'), employeeCount: 200 }],
        },
      },
      ctx,
    );
    expect(inRange.branch).toBe('new');
  });
});

describe('record_score（TC-LEAD-07 覆写 / TC-LEAD-08 低分分流）', () => {
  it('以 matchPct 确定性覆写 LLM 回显的 scoreLevel', async () => {
    const ctx = makeCtx();
    const res = await node('record_score')(
      {
        currentScore: score({ matchPct: 90, scoreLevel: 'low' }),
        discovered: [lead('Real Name', 'real.com')],
      },
      ctx,
    );
    const normalized = (ctx.bag.get('scoredAll') as LeadScore[])[0];
    expect(normalized?.scoreLevel).toBe('high');
    expect(res.branch).toBe('matched');
  });

  it('公司身份以发现阶段为准，不被 LLM 回显污染', async () => {
    const ctx = makeCtx();
    await node('record_score')(
      {
        currentScore: score({ companyName: 'mock-companyName' }),
        discovered: [lead('Real Name', 'real.com')],
      },
      ctx,
    );
    expect((ctx.bag.get('scoredAll') as LeadScore[])[0]?.companyName).toBe('Real Name');
  });

  it('低分（< 分档线）走 low 分支：不进入联系人发现', async () => {
    const ctx = makeCtx();
    const res = await node('record_score')(
      {
        currentScore: score({ matchPct: 45, scoreLevel: 'high' }),
        discovered: [lead('A', 'a.com')],
      },
      ctx,
    );
    expect(res.branch).toBe('low');
    expect((ctx.bag.get('scoredAll') as LeadScore[])[0]?.scoreLevel).toBe('low');
  });

  it('缺失 currentScore → low，不产生脏评分', async () => {
    const ctx = makeCtx();
    const res = await node('record_score')({}, ctx);
    expect(res.branch).toBe('low');
    expect(ctx.bag.get('scoredAll')).toBeUndefined();
  });
});

describe('target_reached（TC-LEAD-04 任务级目标与轮次守护）', () => {
  it('未达目标且轮次未耗尽 → continue（继续搜索）', async () => {
    const ctx = makeCtx({ input: { targetCount: 35 } });
    const res = await node('target_reached')({}, ctx);
    expect(res.branch).toBe('continue');
  });

  it('达到 targetCount → save 收尾', async () => {
    const ctx = makeCtx({
      input: { targetCount: 1 },
      bag: new Map<string, unknown>([['scoredAll', [score({ matchPct: 90 })]]]),
    });
    expect((await node('target_reached')({}, ctx)).branch).toBe('save');
  });

  it('轮次耗尽（maxRounds）→ save，防搜索死循环', async () => {
    const ctx = makeCtx({
      input: { targetCount: 35, advancedSettings: { maxRounds: 2 } },
    });
    expect((await node('target_reached')({}, ctx)).branch).toBe('continue');
    expect((await node('target_reached')({}, ctx)).branch).toBe('save');
  });

  it('targetCount 非法（<1 或非数字）回落 1，不产生 0 目标', async () => {
    const ctx = makeCtx({ input: { targetCount: 0 } });
    expect((await node('target_reached')({}, ctx)).branch).toBe('continue');
    const reached = await node('target_reached')(
      { searchPlan: { targetCount: 1 } },
      makeCtx({
        bag: new Map<string, unknown>([['scoredAll', [score({ matchPct: 90 })]]]),
      }),
    );
    expect(reached.branch).toBe('save');
  });
});

describe('assemble_leads（发现阶段身份回填 + 联系人按域名归并）', () => {
  it('contacts 按归一化域名归并：同名不同域名不互相串数据', async () => {
    const contacts: LeadContact[] = [
      {
        name: 'Ann',
        title: 'Purchasing Manager',
        email: null,
        companyName: 'Acme',
        domain: 'acme.com',
        decisionInfluencePct: 75,
      },
      {
        name: 'Bob',
        title: 'Procurement Director',
        email: null,
        companyName: 'Acme',
        domain: 'acme.co.uk',
        decisionInfluencePct: 90,
      },
    ];
    const ctx = makeCtx({
      bag: new Map<string, unknown>([
        ['scoredAll', [score({ companyName: 'Acme', matchPct: 90 })]],
        ['scoredKeys', ['acme.com']],
        [
          'leadIdentity',
          { 'acme.com': { domain: 'acme.com', website: 'https://acme.com', country: 'US' } },
        ],
        ['contactsAll', contacts],
      ]),
    });
    const res = await node('assemble_leads')({}, ctx);
    const leads = res.patch?.['crmLeads'] as { contacts: LeadContact[]; country: string }[];
    expect(leads).toHaveLength(1);
    expect(leads[0]?.country).toBe('US');
    expect(leads[0]?.contacts.map((c) => c.name)).toEqual(['Ann']);
  });
});

describe('buildWorkflowOutputs（终态 outputs 契约）', () => {
  it('lead_hunting：leads + 统计（TC-E2E-03）', () => {
    const outputs = buildWorkflowOutputs('lead_hunting', {
      crmLeads: [{ companyName: 'A' }, { companyName: 'B' }],
      scored: [{ scoreLevel: 'high' }, { scoreLevel: 'low' }],
    });
    expect(outputs).toHaveLength(1);
    const payload = outputs?.[0]?.['payload'] as Record<string, number>;
    expect(payload['foundCount']).toBe(2);
    expect(payload['analyzedCount']).toBe(2);
    expect(payload['highValueCount']).toBe(1);
  });

  it('email_reply：draft + insight（copilot 不发送也落 outputs）', () => {
    const outputs = buildWorkflowOutputs('email_reply', {
      draft: { subject: 'Re', body: 'hi' },
      intent: { label: 'rfq', confidence: 0.8 },
      copilot: { purchaseProbability: 70, stage: 'negotiation', recommendedActions: ['询价'] },
    });
    expect(outputs?.map((o) => o['type'])).toEqual(['draft', 'insight']);
  });

  it('follow_up 客户已回复 → 仅 insight 转人工交接（TC-XMOD-01）', () => {
    const outputs = buildWorkflowOutputs('follow_up', {
      repliedSinceLast: true,
      content: { subject: 'Follow up', body: 'x' },
    });
    expect(outputs).toHaveLength(1);
    expect(outputs?.[0]?.['type']).toBe('insight');
    expect(outputs?.[0]?.['payload']).toMatchObject({
      paused: true,
      handoff: 'human',
      reason: 'customer_replied',
    });
  });

  it('product_analysis：insight 带 customerId 可溯源（TC-E2E-05）', () => {
    const outputs = buildWorkflowOutputs('product_analysis', {
      copilot: { purchaseProbability: 60, stage: 'contacted', recommendedActions: [] },
      customerId: 'cus_1',
    });
    expect(outputs?.[0]?.['payload']).toMatchObject({ customerId: 'cus_1' });
  });

  it('未注册 taskType → null（回落 runner 通用 result 包裹）', () => {
    expect(buildWorkflowOutputs('unknown_type', {})).toBeNull();
  });
});

describe('LLM 输出契约红线（output-schemas）', () => {
  const schemas = createOutputSchemaRegistry();

  it('parsedGoal 缺失字段留空不脑补（TC-LEAD-02）', () => {
    expect(schemas.get('parsedGoal').safeParse({}).success).toBe(true);
    expect(
      schemas.get('parsedGoal').safeParse({ targetMarket: 'US', targetProduct: '' }).success,
    ).toBe(true);
  });

  it('draftReply：无依据 → grounded=false + missingInfo（TC-INB-04）', () => {
    const ok = schemas.get('draftReply').safeParse({
      subject: 'Re: quote',
      body: 'Please advise MOQ',
      grounded: false,
      missingInfo: ['MOQ', '交期'],
    });
    expect(ok.success).toBe(true);
  });

  it('leadScore：reasons 逐条 Insight Schema；scoreLevel 可选', () => {
    expect(
      schemas
        .get('leadScore')
        .safeParse({ companyName: 'A', matchPct: 88, reasons: [{ text: 'x' }] }).success,
    ).toBe(true);
  });

  it('strict 红线：LLM 多产未知键 → 校验失败（不被静默剥离）', () => {
    expect(
      schemas
        .get('leadScore')
        .safeParse({ companyName: 'A', matchPct: 88, reasons: [], injected: true }).success,
    ).toBe(false);
    expect(
      schemas.get('draftReply').safeParse({ subject: 'a', body: 'b', grounded: true, extra: 1 })
        .success,
    ).toBe(false);
  });

  it('数值边界：matchPct 0~100、confidence 0~1（TC-C360-10）', () => {
    expect(
      schemas.get('leadScore').safeParse({ companyName: 'A', matchPct: 101, reasons: [] }).success,
    ).toBe(false);
    expect(schemas.get('intent').safeParse({ label: 'rfq', confidence: 1.2 }).success).toBe(false);
    expect(schemas.get('intent').safeParse({ label: 'rfq', confidence: 0.999 }).success).toBe(true);
  });
});

describe('SOP ↔ 注册表交叉一致性（补充覆盖）', () => {
  const flowRegistry = createFlowRegistry();
  const promptRegistry = createPromptRegistry();
  const schemaRegistry = createOutputSchemaRegistry();
  const toolRegistry = createToolRegistry();

  it('P0 七张 SOP 图齐备', () => {
    expect(Object.keys(WORKFLOW_SOP_DEFINITIONS).sort()).toEqual(
      [
        'business_analysis',
        'email_reply',
        'follow_up',
        'lead_hunting',
        'order_monitor',
        'product_analysis',
        'product_knowledge',
      ].sort(),
    );
  });

  for (const [taskType, sop] of Object.entries(WORKFLOW_SOP_DEFINITIONS)) {
    describe(`${taskType}`, () => {
      const nodeIds = new Set(sop.nodes.map((n) => n.id));

      it('entry 节点存在且节点 id 唯一', () => {
        expect(nodeIds.has(sop.entry)).toBe(true);
        expect(nodeIds.size).toBe(sop.nodes.length);
      });

      it('所有边的端点都指向已声明节点', () => {
        for (const edge of sop.edges) {
          expect(nodeIds.has(edge.from)).toBe(true);
          expect(nodeIds.has(edge.to)).toBe(true);
        }
      });

      it('flow 节点的 route 已在 flow 注册表注册', () => {
        for (const n of sop.nodes) {
          if (n.kind !== 'flow') {
            continue;
          }
          expect(flowRegistry.has(n.route ?? n.id)).toBe(true);
        }
      });

      it('tool 节点引用的工具已在 tools 注册表注册', () => {
        for (const n of sop.nodes) {
          if (n.kind !== 'tool') {
            continue;
          }
          expect(toolRegistry.has(n.tool)).toBe(true);
        }
      });

      it('llm 节点的 promptRef / outputSchema 均已注册', () => {
        for (const n of sop.nodes) {
          if (n.kind !== 'llm') {
            continue;
          }
          expect(promptRegistry.get(n.promptRef)).toBeTruthy();
          if (n.outputSchema) {
            expect(schemaRegistry.has(n.outputSchema)).toBe(true);
          }
        }
      });

      it('节点进度值域 0~100（运行期以 least(100, ...) 夹紧累加）', () => {
        for (const n of sop.nodes) {
          if (n.progress === undefined) {
            continue;
          }
          expect(n.progress).toBeGreaterThanOrEqual(0);
          expect(n.progress).toBeLessThanOrEqual(100);
        }
      });
    });
  }

  it('提示词模板齐备且带红线约束（补充覆盖）', () => {
    // 7 个 taskType 各自的 llm 节点提示词均已注册
    const refs = new Set<string>();
    for (const sop of Object.values(WORKFLOW_SOP_DEFINITIONS)) {
      for (const n of sop.nodes) {
        if (n.kind === 'llm') {
          refs.add(n.promptRef);
        }
      }
    }
    expect(refs.size).toBeGreaterThanOrEqual(7);
    for (const ref of refs) {
      const tpl = promptRegistry.get(ref);
      expect(tpl.system.length).toBeGreaterThan(0);
      expect(tpl.user.length).toBeGreaterThan(0);
    }
    // 红线：目标解析「缺失字段留空不脑补」、回复草稿「无依据 grounded=false 禁止编造」
    expect(promptRegistry.get('leadHunting.parseGoal').system).toContain('缺失字段留空');
    expect(promptRegistry.get('sales.draftReply').system).toContain('grounded=false');
    expect(promptRegistry.get('sales.draftReply').system).toContain('禁止编造');
  });

  it('workflowSopProvider：未知 taskType → 40401，outputs 委托 buildWorkflowOutputs', () => {
    expect(() => workflowSopProvider.get('not_exist')).toThrow(/40401|无内置 SOP/);
    const { stateKeys } = workflowSopProvider.get('lead_hunting');
    expect(stateKeys).toContain('taskId');
    expect(workflowSopProvider.buildOutputs('unknown_type', {})).toBeNull();
  });
});
