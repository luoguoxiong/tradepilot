import request from 'supertest';

import type { Company } from '@prisma/client';

import { getApp, registerUser, authGet, authPost, closeApp } from './helpers';

async function pollTask(
  app: Awaited<ReturnType<typeof getApp>>,
  token: string,
  taskId: string,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 30; i++) {
    const res = await authGet(app, `/api/search-tasks/${taskId}`, token);
    const task = res.body;
    if (['DONE', 'FAILED'].includes(task.status)) return task;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('task polling timeout');
}

describe('Search Tasks（Mock Adapter → 异步执行 → 企业落库）', () => {
  let app: Awaited<ReturnType<typeof getApp>>;

  beforeAll(async () => {
    app = await getApp();
  });
  afterAll(async () => {
    await closeApp();
  });

  it('创建任务 → 异步执行完成 → 企业以 DEMO 标记落库', async () => {
    const { token } = await registerUser(app);

    const created = await authPost(app, '/api/search-tasks', token, {
      productKeywords: ['test widget pro'],
      country: 'US',
      companyTypes: ['Importer'],
      limit: 3,
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('PENDING');

    const task = await pollTask(app, token, created.body.id as string);
    expect(task.status).toBe('DONE');
    expect(task.totalCompanies).toBe(3);

    // 企业列表可见 DEMO 数据（Mock 域名含关键词 slug）
    const list = await authGet(app, '/api/companies?q=test-widget-pro', token);
    expect(list.status).toBe(200);
    const demoRows = list.body.data.filter((c: { source: string }) => c.source === 'demo');
    expect(demoRows.length).toBeGreaterThanOrEqual(3);
  });

  it('进口商判定与供应商过滤：供应商角色企业不评分不发信，列表可见可筛选', async () => {
    const { token } = await registerUser(app);

    // 唯一关键词 → 独立 dedupeKey，避免确定性 Mock 数据跨运行残留（历史上同域名企业可能已被评过分）
    const keyword = `role filter widget ${Date.now()}`;
    const slug = keyword.replace(/\s+/g, '-');
    // limit=6 → Mock 第 6 家（i=4）为供应商样例
    const created = await authPost(app, '/api/search-tasks', token, {
      productKeywords: [keyword],
      country: 'US',
      companyTypes: ['Importer'],
      limit: 6,
    });
    expect(created.status).toBe(201);
    const task = await pollTask(app, token, created.body.id as string);
    expect(task.status).toBe('DONE');
    expect(task.totalCompanies).toBe(6);
    expect(Number(task.filteredCount)).toBeGreaterThanOrEqual(1);

    const list = await authGet(app, `/api/companies?q=${slug}`, token);
    expect(list.status).toBe(200);
    const demoRows = list.body.data.filter((c: Company) => c.source === 'demo') as Company[];
    expect(demoRows.length).toBe(6);

    const suppliers = demoRows.filter((c) => c.businessRole === 'SUPPLIER');
    const importers = demoRows.filter((c) => c.businessRole === 'IMPORTER');
    expect(suppliers.length).toBeGreaterThanOrEqual(1);
    expect(importers.length).toBeGreaterThanOrEqual(1);
    for (const s of suppliers) expect(s.roleSignals.length).toBeGreaterThanOrEqual(1);

    // 供应商不评分不发信：无 leadScore、无草稿；进口商有评分
    for (const s of suppliers) {
      const detail = await authGet(app, `/api/companies/${s.id}`, token);
      expect(detail.body.latestScore).toBeNull();
      const drafts = await authGet(app, `/api/companies/${s.id}/email-drafts`, token);
      expect(drafts.status).toBe(200);
      expect(drafts.body.length ?? drafts.body.data?.length ?? 0).toBe(0);
    }
    for (const c of importers) {
      const detail = await authGet(app, `/api/companies/${c.id}`, token);
      expect(detail.body.latestScore).not.toBeNull();
    }

    // 角色筛选：role=IMPORTER 只回进口商，role=SUPPLIER 只回供应商
    const importerOnly = await authGet(app, `/api/companies?q=${slug}&role=IMPORTER`, token);
    expect(importerOnly.body.data.every((c: Company) => c.businessRole === 'IMPORTER')).toBe(true);
    const supplierOnly = await authGet(app, `/api/companies?q=${slug}&role=SUPPLIER`, token);
    expect(supplierOnly.body.data.length).toBe(suppliers.length);
  });

  it('手动重判端点：POST /companies/:id/classify 幂等返回角色', async () => {
    const { token } = await registerUser(app);
    const keyword = `classify widget ${Date.now()}`;
    const slug = keyword.replace(/\s+/g, '-');
    const created = await authPost(app, '/api/search-tasks', token, {
      productKeywords: [keyword],
      country: 'US',
      companyTypes: ['Importer'],
      limit: 2,
    });
    await pollTask(app, token, created.body.id as string);
    const list = await authGet(app, `/api/companies?q=${slug}`, token);
    const target = list.body.data[0] as Company;
    expect(target).toBeDefined();

    const res = await request(app.getHttpServer())
      .post(`/api/companies/${target.id}/classify`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(201);
    expect(['IMPORTER', 'SUPPLIER', 'UNCLEAR']).toContain(res.body.role);

    const again = await request(app.getHttpServer())
      .post(`/api/companies/${target.id}/classify`)
      .set('Authorization', `Bearer ${token}`);
    expect(again.body).toEqual(res.body); // 确定性幂等
  });

  it('非法国家 → 422；空关键词 → 422', async () => {
    const { token } = await registerUser(app);
    const badCountry = await authPost(app, '/api/search-tasks', token, {
      productKeywords: ['x'],
      country: 'JP',
      companyTypes: ['Importer'],
    });
    expect(badCountry.status).toBe(422);

    const emptyKeywords = await authPost(app, '/api/search-tasks', token, {
      productKeywords: [],
      country: 'US',
      companyTypes: ['Importer'],
    });
    expect(emptyKeywords.status).toBe(422);
  });

  it('他人任务详情 → 404（归属校验）', async () => {
    const userA = await registerUser(app);
    const userB = await registerUser(app);
    const created = await authPost(app, '/api/search-tasks', userA.token, {
      productKeywords: ['private task'],
      country: 'US',
      companyTypes: ['Importer'],
      limit: 1,
    });
    const stolen = await authGet(app, `/api/search-tasks/${created.body.id}`, userB.token);
    expect(stolen.status).toBe(404);
  });
});
