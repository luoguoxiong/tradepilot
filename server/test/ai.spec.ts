import request from 'supertest';

import { getApp, registerUser, authGet, authPost, closeApp } from './helpers';
import { PrismaService } from '../src/prisma/prisma.service';
import { DeepSeekLlmClient } from '../src/ai/llm/deepseek.client';
import { LlmOutputError, LlmClient } from '../src/ai/llm/types';
import { computeWeightedScore, LeadScoringService } from '../src/ai/scoring/lead-scoring.service';
import { z } from 'zod';

const ScoreSchema = z.object({
  score: z.number(),
  grade: z.string(),
  subScores: z.object({
    product: z.number(),
    business: z.number(),
    customs: z.number(),
    contact: z.number(),
    region: z.number(),
  }),
  matchReasons: z.array(z.string()),
  purchaseNeeds: z.string(),
  opportunities: z.string(),
  suggestions: z.string(),
  uncertaintyNotes: z.string(),
  model: z.string(),
});

async function createSearchTaskAndPickCompany(
  app: Awaited<ReturnType<typeof getApp>>,
  token: string,
  keyword: string,
): Promise<string> {
  await authPost(app, '/api/search-tasks', token, {
    productKeywords: [keyword],
    country: 'US',
    companyTypes: ['Importer'],
    limit: 2,
  });
  const list = await authGet(app, `/api/companies?q=${encodeURIComponent(keyword)}`, token);
  return list.body.data[0].id as string;
}

describe('AI 评分与开发信（阶段 6 验收门）', () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let prisma: PrismaService;
  let token: string;
  let summitId: string; // 种子企业：有海关记录
  let noRecordId: string; // 搜索企业：无海关记录
  let lastScorePayload: unknown;

  beforeAll(async () => {
    app = await getApp();
    prisma = app.get(PrismaService);
    token = (await registerUser(app)).token;
    summitId = (
      await prisma.company.findUniqueOrThrow({ where: { dedupeKey: 'summitsports.com' } })
    ).id;
    noRecordId = await createSearchTaskAndPickCompany(app, token, 'ai-norecord-widget');
  });
  afterAll(async () => {
    await closeApp();
  });

  it('验收门：同一企业连续两次评分，分数波动 ≤ 10 且等级一致', async () => {
    const first = ScoreSchema.parse((await authPost(app, `/api/companies/${summitId}/lead-scores`, token)).body);
    const second = ScoreSchema.parse((await authPost(app, `/api/companies/${summitId}/lead-scores`, token)).body);
    expect(Math.abs(first.score - second.score)).toBeLessThanOrEqual(10);
    expect(first.grade).toBe(second.grade);
    // 规则降级确定性 → 波动应为 0
    expect(first.model).toBe('mock-rules-v1');
    lastScorePayload = first;
  });

  it('六项解释性输出齐全，且总分与五维子分按 PRD 权重一致', () => {
    const s = ScoreSchema.parse(lastScorePayload);
    expect(s.matchReasons.length).toBeGreaterThanOrEqual(1);
    expect(s.purchaseNeeds.length).toBeGreaterThan(0);
    expect(s.opportunities.length).toBeGreaterThan(0);
    expect(s.suggestions.length).toBeGreaterThan(0);
    expect(s.uncertaintyNotes.length).toBeGreaterThan(0);
    expect(s.score).toBe(computeWeightedScore(s.subScores));
  });

  it('评分历史可读（每次评分落库）', async () => {
    const history = await authGet(app, `/api/companies/${summitId}/lead-scores`, token);
    expect(history.status).toBe(200);
    expect(history.body.length).toBeGreaterThanOrEqual(2);
  });

  it('采购记录缺失时照常评分，uncertaintyNotes 注明数据缺失', async () => {
    const scored = ScoreSchema.parse(
      (await authPost(app, `/api/companies/${noRecordId}/lead-scores`, token)).body,
    );
    expect(scored.score).toBeGreaterThanOrEqual(0);
    expect(scored.uncertaintyNotes.toLowerCase()).toContain('no customs import records');
  });

  it('开发信包含企业名与产品关联（subject）', async () => {
    const draft = (
      await authPost(app, `/api/companies/${summitId}/email-drafts`, token, {})
    ).body;
    expect(draft.subject).toContain('Summit Sports Gear LLC');
    expect(draft.model).toBe('mock-template-v1');
    // 该企业有（DEMO）海关记录 → 允许提及；body 非空
    expect(draft.body.length).toBeGreaterThan(50);
  });

  it('无采购记录企业的开发信不含伪造采购内容', async () => {
    const draft = (
      await authPost(app, `/api/companies/${noRecordId}/email-drafts`, token, {})
    ).body;
    const all = `${draft.subject} ${draft.body} ${draft.followUp1} ${draft.followUp2}`.toLowerCase();
    expect(all).not.toMatch(/shipment|import record|purchasing history|hs ?code/);
  });

  it('草稿可编辑（PATCH）', async () => {
    const created = (await authPost(app, `/api/companies/${summitId}/email-drafts`, token, {})).body;
    const patched = await request(app.getHttpServer())
      .patch(`/api/companies/email-drafts/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subject: 'Edited subject by test' });
    expect(patched.status).toBe(200);
    expect(patched.body.subject).toBe('Edited subject by test');
  });

  it('异常注入：LLM 返回非法 JSON → 结构化 503（不 500）', async () => {
    // 真实 DeepSeekLlmClient + mock fetch（jest 29 node 环境无 Response 构造器，用对象 stub）
    const badFetch = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'NOT-JSON' }, finish_reason: 'stop' }], usage: {} }),
    } as unknown as globalThis.Response);
    const client = new DeepSeekLlmClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'm', timeoutMs: 500 });
    await expect(
      client.chatJson({
        system: 's',
        user: 'u',
        schema: z.object({ a: z.number() }),
        maxTokens: 100,
      }),
    ).rejects.toBeInstanceOf(LlmOutputError);
    badFetch.mockRestore();

    // 服务层把 LlmOutputError 映射为 ServiceUnavailableException（过滤器转 503 结构化错误）
    const service = app.get(LeadScoringService);
    const badClient: LlmClient = {
      chatJson: () => Promise.reject(new LlmOutputError('INVALID_JSON', 'bad json')),
    };
    await expect(service.score(summitId, 'user-x', badClient)).rejects.toMatchObject({
      status: 503,
      response: { code: 'LLM_OUTPUT_INVALID' },
    });
  });

  it('非法 finish_reason=length（截断）也按无效输出处理', async () => {
    const truncated = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{"a":1}' }, finish_reason: 'length' }], usage: {} }),
    } as unknown as globalThis.Response);
    const client = new DeepSeekLlmClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'm', timeoutMs: 500 });
    await expect(
      client.chatJson({ system: 's', user: 'u', schema: z.object({ a: z.number() }), maxTokens: 10 }),
    ).rejects.toMatchObject({ code: 'TRUNCATED' });
    truncated.mockRestore();
  });
});
