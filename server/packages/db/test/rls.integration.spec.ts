import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createId } from '@tradepilot/core';
import {
  closeDb,
  createDb,
  notDeleted,
  schema,
  withLoginContext,
  withOrg,
  type Db,
} from '../src/index.js';

/**
 * M2 数据层集成测试（后端技术方案 02 §4 / 03 §3）。
 * 前置：docker compose up（PG 5432）+ `pnpm migrate` 已执行。
 * - 引导数据用超级用户连接（BYPASSRLS）
 * - 断言用 tradepilot_app 连接（FORCE RLS 生效）
 */

const SUPER_URL = 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';
const APP_URL = 'postgresql://tradepilot_app:changeme_app@localhost:5432/tradepilot';

let superDb: Db;
let appDb: Db;

const ORG_A = createId('org');
const ORG_B = createId('org');
const USER_A = createId('usr');
const EMAIL_A = `it-admin-${ORG_A}@test.com`;
const CUS_A1 = createId('cus');
const CUS_A2 = createId('cus');
const CUS_B1 = createId('cus');

beforeAll(async () => {
  superDb = createDb(SUPER_URL, { max: 2 });
  appDb = createDb(APP_URL, { max: 2 });

  // 引导：两个租户 + 各自用户/客户（超级用户旁路 RLS）
  await superDb.transaction(async (tx) => {
    await tx.insert(schema.org).values([
      { id: ORG_A, name: 'IT租户A' },
      { id: ORG_B, name: 'IT租户B' },
    ]);
    await tx
      .insert(schema.userAccount)
      .values([
        {
          id: USER_A,
          orgId: ORG_A,
          email: EMAIL_A,
          passwordHash: 'x',
          name: 'A管理员',
          role: 'admin',
          status: 'active',
        },
      ]);
    await tx.insert(schema.customer).values([
      { id: CUS_A1, orgId: ORG_A, companyName: 'A客户-可见', country: 'US', ownerId: USER_A },
      { id: CUS_A2, orgId: ORG_A, companyName: 'A客户-软删', country: 'US', ownerId: USER_A },
      { id: CUS_B1, orgId: ORG_B, companyName: 'B客户-隔离', country: 'DE', ownerId: USER_A },
    ]);
  });

  // 软删 A2
  await superDb
    .update(schema.customer)
    .set({ deletedAt: new Date() })
    .where(eq(schema.customer.id, CUS_A2));
});

afterAll(async () => {
  await superDb.transaction(async (tx) => {
    await tx.delete(schema.quotation).where(sql`${schema.quotation.orgId} IN (${ORG_A}, ${ORG_B})`);
    await tx.delete(schema.customer).where(sql`${schema.customer.orgId} IN (${ORG_A}, ${ORG_B})`);
    await tx.delete(schema.userAccount).where(eq(schema.userAccount.orgId, ORG_A));
    await tx.delete(schema.org).where(sql`${schema.org.id} IN (${ORG_A}, ${ORG_B})`);
  });
  await closeDb(appDb);
  await closeDb(superDb);
});

describe('RLS 多租户隔离（02 §4.2/§4.3）', () => {
  it('fail-closed：未设置 app.org_id 时返回空集', async () => {
    const rows = await appDb.select().from(schema.customer);
    expect(rows).toEqual([]);
  });

  it('org 上下文只可见本租户行，B 租户行不可见', async () => {
    await withOrg(appDb, ORG_A, async (tx) => {
      const rows = await tx.select({ id: schema.customer.id }).from(schema.customer);
      expect(rows.map((r) => r.id).sort()).toEqual([CUS_A1, CUS_A2].sort());
    });
  });

  it('越权写：写入其他租户 org_id 被 WITH CHECK 拒绝', async () => {
    await expect(
      withOrg(appDb, ORG_A, (tx) =>
        tx.insert(schema.customer).values({
          id: createId('cus'),
          orgId: ORG_B,
          companyName: '越权客户',
          country: 'US',
          ownerId: USER_A,
        }),
      ),
    ).rejects.toThrow();
  });

  it('org 表按 id 隔离：A 看不到 B 的组织行', async () => {
    await withOrg(appDb, ORG_A, async (tx) => {
      const rows = await tx.select({ id: schema.org.id }).from(schema.org);
      expect(rows.map((r) => r.id)).toEqual([ORG_A]);
    });
  });

  it('login_lookup：登录上下文可全局按 email 定位用户（03 §1.1）', async () => {
    const rows = await withLoginContext(appDb, (tx) =>
      tx
        .select({ id: schema.userAccount.id })
        .from(schema.userAccount)
        .where(eq(schema.userAccount.email, EMAIL_A)),
    );
    expect(rows.map((r) => r.id)).toEqual([USER_A]);
  });
});

describe('软删过滤与金额往返（02 §6.1 / ER 07）', () => {
  it('notDeleted() 过滤已软删行；引用回溯场景显式绕过', async () => {
    await withOrg(appDb, ORG_A, async (tx) => {
      const visible = await tx
        .select({ id: schema.customer.id })
        .from(schema.customer)
        .where(and(notDeleted(schema.customer.deletedAt)));
      expect(visible.map((r) => r.id)).toEqual([CUS_A1]);

      const all = await tx.select({ id: schema.customer.id }).from(schema.customer);
      expect(all.map((r) => r.id).sort()).toEqual([CUS_A1, CUS_A2].sort());
    });
  });

  it('numeric 金额精度往返无损（total 18,2 / rate 18,8）', async () => {
    const quoteId = createId('quote');
    await withOrg(appDb, ORG_A, async (tx) => {
      await tx.insert(schema.quotation).values({
        id: quoteId,
        orgId: ORG_A,
        quoteNo: `IT-${quoteId}`,
        customerId: CUS_A1,
        currency: 'USD',
        incoterms: 'FOB',
        validUntil: '2026-12-31',
        exchangeRate: '0.12345678',
        exchangeRateDate: '2026-09-06',
        exchangeRateSource: 'manual',
        paymentTerms: 'T/T 30%',
        totalAmount: '12345.67',
        ownerId: USER_A,
        createdBy: USER_A,
      });

      const [row] = await tx
        .select({
          totalAmount: schema.quotation.totalAmount,
          exchangeRate: schema.quotation.exchangeRate,
        })
        .from(schema.quotation)
        .where(eq(schema.quotation.id, quoteId));
      expect(row.totalAmount).toBe('12345.67');
      expect(row.exchangeRate).toBe('0.12345678');
    });
  });
});
