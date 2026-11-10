import request from 'supertest';

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
