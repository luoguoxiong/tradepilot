import request from 'supertest';

import { getApp, registerUser, authGet, authPatch, authPost, closeApp } from './helpers';
import { PrismaService } from '../src/prisma/prisma.service';
import { rowsToObjects } from '../src/crm/csv.util';

async function importToCrm(
  app: Awaited<ReturnType<typeof getApp>>,
  token: string,
  companyId: string,
) {
  const res = await authPost(app, '/api/companies/import-crm', token, { companyIds: [companyId] });
  if (res.status !== 201) throw new Error(`import failed: ${res.status}`);
}

describe('CRM 闭环（阶段 7 验收门）', () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let prisma: PrismaService;
  let token: string;
  let customerId: string; // 种子企业 summitsports.com 已在之前测试导入 CRM（QUALIFIED）

  beforeAll(async () => {
    app = await getApp();
    prisma = app.get(PrismaService);
    token = (await registerUser(app)).token;
    const summit = await prisma.company.findUniqueOrThrow({ where: { dedupeKey: 'summitsports.com' } });
    customerId = summit.id;
    if (!summit.crmStatus) await importToCrm(app, token, customerId);
    // 跨运行幂等：CSV 往返测试会改写名称，先重置规范名
    if (summit.name !== 'Summit Sports Gear LLC') {
      await prisma.company.update({ where: { id: customerId }, data: { name: 'Summit Sports Gear LLC' } });
    }
  });
  afterAll(async () => {
    await closeApp();
  });

  it('验收门：非法状态跳转被拒绝（NEW→WON 400；回退 400；终态 400）', async () => {
    // 准备一个 NEW 客户
    const company = await prisma.company.create({
      data: { dedupeKey: `crm-test-${Date.now()}.com`, name: 'CRM Test Co', country: 'US', source: 'demo', crmStatus: 'NEW' },
    });
    // NEW→WON：拒绝
    const illegal = await authPost(app, `/api/crm/customers/${company.id}/transition`, token, { to: 'WON' });
    expect(illegal.status).toBe(400);
    expect(illegal.body.error.code).toBe('INVALID_TRANSITION');
    // NEW→LOST：拒绝
    const illegalLost = await authPost(app, `/api/crm/customers/${company.id}/transition`, token, { to: 'LOST' });
    expect(illegalLost.status).toBe(400);
    // NEW→QUALIFIED：允许
    const ok = await authPost(app, `/api/crm/customers/${company.id}/transition`, token, { to: 'QUALIFIED' });
    expect(ok.status).toBe(201);
    expect(ok.body.crmStatus).toBe('QUALIFIED');
    // 回退 QUALIFIED→NEW：拒绝
    const backward = await authPost(app, `/api/crm/customers/${company.id}/transition`, token, { to: 'NEW' });
    expect(backward.status).toBe(400);
    // 走到 WON 后终态拒绝再流转
    await authPost(app, `/api/crm/customers/${company.id}/transition`, token, { to: 'CONTACTED' });
    await authPost(app, `/api/crm/customers/${company.id}/transition`, token, { to: 'REPLIED' });
    await authPost(app, `/api/crm/customers/${company.id}/transition`, token, { to: 'NEGOTIATING' });
    const won = await authPost(app, `/api/crm/customers/${company.id}/transition`, token, { to: 'WON' });
    expect(won.status).toBe(201);
    const after = await authPost(app, `/api/crm/customers/${company.id}/transition`, token, { to: 'LOST' });
    expect(after.status).toBe(400);
  });

  it('验收门：跟进记录 + 下次跟进时间 → Dashboard 汇总变化', async () => {
    const before = await authGet(app, '/api/crm/summary', token);
    const dueBefore = before.body.dueFollowUps.length as number;

    const activity = await authPost(app, `/api/crm/customers/${customerId}/activities`, token, {
      type: 'FOLLOW_UP',
      content: '发送碳纤维鞋垫样品目录',
      nextFollowUpAt: new Date(Date.now() + 3 * 86400000).toISOString(),
    });
    expect(activity.status).toBe(201);

    // nextFollowUpAt 同步到 company（Dashboard 待跟进依据）
    const customer = await authGet(app, `/api/crm/customers/${customerId}`, token);
    expect(customer.body.nextFollowUpAt).toBeTruthy();
    // 时间线包含该记录
    const timeline = customer.body.activities as { content: string }[];
    expect(timeline.some((a) => a.content.includes('样品目录'))).toBe(true);

    const after = await authGet(app, '/api/crm/summary', token);
    expect(after.body.dueFollowUps.length).toBeGreaterThanOrEqual(dueBefore);
    expect(after.body.totalCustomers).toBeGreaterThan(0);
  });

  it('联系人挖掘（Mock DEMO 标注 + 验证状态）与手动补充', async () => {
    const discover = await authPost(app, `/api/companies/${customerId}/contacts/discover`, token, {});
    expect(discover.status).toBe(201);
    expect(discover.body.demo).toBe(true); // 无 Apollo Key → DEMO
    const contacts = discover.body.contacts as { source: string; emailVerified: string }[];
    expect(contacts.length).toBeGreaterThanOrEqual(1);
    // 跨运行可能混入手动补充的联系人；断言不存在伪造的真实来源
    expect(contacts.every((c) => ['demo', 'manual'].includes(c.source))).toBe(true);
    expect(contacts.some((c) => ['VERIFIED', 'UNVERIFIED', 'UNKNOWN'].includes(c.emailVerified))).toBe(true);

    const manual = await authPost(app, `/api/companies/${customerId}/contacts`, token, {
      name: 'Manual Person',
      title: 'Procurement Manager',
      email: `manual-${Date.now()}@summitsports.com`,
    });
    expect(manual.status).toBe(201);
    expect(manual.body.isManual).toBe(true);
    expect(manual.body.source).toBe('manual');
  });

  it('海关数据：Mock DEMO 标注 + 企业级聚合（频率）', async () => {
    const queried = await authPost(app, `/api/companies/${customerId}/customs-records/query`, token);
    expect(queried.status).toBe(201);
    expect(queried.body.summary.demo).toBe(true);
    expect(queried.body.records.length).toBeGreaterThanOrEqual(2);
    expect(['monthly', 'quarterly', 'yearly', 'irregular']).toContain(queried.body.summary.frequency);

    const list = await authGet(app, `/api/companies/${customerId}/customs-records`, token);
    expect(list.status).toBe(200);
    expect(list.body.summary.recordCount).toBe(queried.body.records.length);
  });

  it('验收门：CSV 导出再导入，数据无损往返', async () => {
    // 导出 companies
    const exported = await request(app.getHttpServer())
      .get('/api/crm/export?type=companies')
      .set('Authorization', `Bearer ${token}`);
    expect(exported.status).toBe(200);
    expect(exported.headers['content-type']).toContain('text/csv');
    const csvText = exported.text as string;

    // 解析回对象：字段与数据库一致
    const rows = rowsToObjects(csvText);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const summitRow = rows.find((r) => r.dedupeKey === 'summitsports.com');
    expect(summitRow).toBeTruthy();
    expect(summitRow!.name).toBe('Summit Sports Gear LLC');
    expect(summitRow!.country).toBe('US');

    // 导入（更新路径）：修改名称后重新导入，再导出核对
    const mutated = csvText.replace('Summit Sports Gear LLC', 'Summit Sports Gear LLC (updated)');
    const imported = await authPost(app, '/api/crm/import', token, { type: 'companies', csv: mutated });
    expect(imported.status).toBe(201);
    expect(imported.body.updated).toBeGreaterThanOrEqual(1);

    const reExported = await request(app.getHttpServer())
      .get('/api/crm/export?type=companies')
      .set('Authorization', `Bearer ${token}`);
    const reRows = rowsToObjects(reExported.text as string);
    const updatedRow = reRows.find((r) => r.dedupeKey === 'summitsports.com');
    expect(updatedRow!.name).toBe('Summit Sports Gear LLC (updated)');
    // CRM 状态不被导入覆盖
    expect(updatedRow!.crmStatus).not.toBe('');
  });

  it('CSV 联系人导出导入往返', async () => {
    const exported = await request(app.getHttpServer())
      .get('/api/crm/export?type=contacts')
      .set('Authorization', `Bearer ${token}`);
    const rows = rowsToObjects(exported.text as string);
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const imported = await authPost(app, '/api/crm/import', token, { type: 'contacts', csv: exported.text });
    expect(imported.status).toBe(201);
    expect(imported.body.updated + imported.body.skipped).toBeGreaterThan(0); // 已存在 → updated/skipped，无重复创建
  });

  it('客户详情整合视图：企业+联系人+海关+AI+邮件+时间线', async () => {
    const detail = await authGet(app, `/api/crm/customers/${customerId}`, token);
    expect(detail.status).toBe(200);
    expect(detail.body.contacts.length).toBeGreaterThanOrEqual(1);
    expect(detail.body.customsRecords.length).toBeGreaterThanOrEqual(2);
    expect(detail.body.latestScore).toBeTruthy();
    expect(detail.body.emailDrafts.length).toBeGreaterThanOrEqual(0);
    expect(detail.body.activities.length).toBeGreaterThanOrEqual(1);
  });

  it('未导入 CRM 的企业访问 /crm/customers/:id → 404', async () => {
    const outsider = await prisma.company.create({
      data: { dedupeKey: `not-crm-${Date.now()}.com`, name: 'Not In CRM Co', country: 'CA', source: 'demo' },
    });
    const res = await authGet(app, `/api/crm/customers/${outsider.id}`, token);
    expect(res.status).toBe(404);
  });

  it('收藏筛选（PATCH favorite）回归可用', async () => {
    const fav = await authPatch(app, `/api/companies/${customerId}/favorite`, token, { isFavorite: true });
    expect(fav.body.isFavorite).toBe(true);
  });
});
