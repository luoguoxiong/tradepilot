import request from 'supertest';

import { getApp, registerUser, authGet, authPatch, authPost, closeApp } from './helpers';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Companies（收藏/批量导入 CRM）与 Integrations（Key 加密+掩码）', () => {
  let app: Awaited<ReturnType<typeof getApp>>;

  beforeAll(async () => {
    app = await getApp();
  });
  afterAll(async () => {
    await closeApp();
  });

  it('收藏切换 + 只看收藏筛选', async () => {
    const { token } = await registerUser(app);
    await authPost(app, '/api/search-tasks', token, {
      productKeywords: ['fav widget'],
      country: 'CA',
      companyTypes: ['Wholesaler'],
      limit: 2,
    });
    const list = await authGet(app, '/api/companies?q=fav-widget', token);
    const target = list.body.data[0];

    const fav = await authPatch(app, `/api/companies/${target.id}/favorite`, token, { isFavorite: true });
    expect(fav.body.isFavorite).toBe(true);

    const onlyFav = await authGet(app, '/api/companies?isFavorite=true', token);
    expect(onlyFav.body.data.some((c: { id: string }) => c.id === target.id)).toBe(true);
  });

  it('批量导入 CRM：置 NEW + 审计日志；重复导入 skipped', async () => {
    const { token } = await registerUser(app);
    // Mock 确定性生成同 dedupeKey 企业：重置 CRM 状态，保证跨运行幂等
    const prisma = app.get(PrismaService);
    await prisma.company.updateMany({
      where: { dedupeKey: { contains: 'crm-widget' } },
      data: { crmStatus: null, ownerUserId: null },
    });

    await authPost(app, '/api/search-tasks', token, {
      productKeywords: ['crm widget'],
      country: 'US',
      companyTypes: ['Distributor'],
      limit: 2,
    });
    const list = await authGet(app, '/api/companies?q=crm-widget', token);
    const ids: string[] = list.body.data.map((c: { id: string }) => c.id);

    const first = await authPost(app, '/api/companies/import-crm', token, { companyIds: ids });
    expect(first.status).toBe(201);
    expect(first.body.imported).toBe(2);
    expect(first.body.skipped).toBe(0);

    const again = await authPost(app, '/api/companies/import-crm', token, { companyIds: ids });
    expect(again.body.skipped).toBe(2);

    const after = await authGet(app, '/api/companies?inCrm=true', token);
    const crmRows = after.body.data.filter((c: { id: string }) => ids.includes(c.id));
    expect(crmRows.every((c: { crmStatus: string; ownerUserId: string }) => c.crmStatus === 'NEW' && c.ownerUserId)).toBe(true);
  });

  it('integrations：保存加密 → 列表只回掩码 → 清除', async () => {
    const { token } = await registerUser(app);

    const saved = await authPatch(app, '/api/integrations/serper', token, {
      apiKey: 'SERP-SECRET-VALUE-ABCD1234',
    });
    expect(saved.status).toBe(200);
    expect(saved.body.keyPreview).toBe('****1234');
    expect(JSON.stringify(saved.body)).not.toContain('SERP-SECRET-VALUE');

    const list = await authGet(app, '/api/integrations', token);
    const serper = (list.body as { provider: string; configured: boolean }[]).find(
      (i) => i.provider === 'serper',
    );
    expect(serper?.configured).toBe(true);
    expect(JSON.stringify(list.body)).not.toContain('SERP-SECRET-VALUE');

    const removed = await request(app.getHttpServer())
      .delete('/api/integrations/serper')
      .set('Authorization', `Bearer ${token}`);
    expect(removed.status).toBe(200);

    const after = await authGet(app, '/api/integrations', token);
    const cleared = (after.body as { provider: string; configured: boolean }[]).find(
      (i) => i.provider === 'serper',
    );
    expect(cleared?.configured).toBe(false);
  });
});
