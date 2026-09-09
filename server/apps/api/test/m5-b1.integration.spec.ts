import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { createId, ErrorCode } from '@tradepilot/core';
import { closeDb, createDb, schema, type Db, type OrgScopeContext } from '@tradepilot/db';
import { EnvService } from '../src/config/env.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { TokenService } from '../src/auth/token.service.js';
import { CustomersService } from '../src/customers/customers.service.js';

/**
 * M5-B1 CRM 收尾集成测试（后端开发计划表 B1）：
 * - 软删（锁定态走审批 / 非锁定态直接删）
 * - batch-delete（仅 manager/admin）
 * - batch-owner（仅 manager/admin + owner_change 活动留痕）
 * - contacts CRUD（创建/编辑/删除单条不走审批）
 * - activities 全局列表（refType+refId 跳转 + type 筛选 + scope 注入）
 * 前置：docker compose up（PG 5432 / Redis 6380）+ 迁移已执行。
 */

process.env.JWT_SECRET ||= 'it_only_test_secret_0123456789abcdef0123456789abcdef';
process.env.ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.REDIS_URL ||= 'redis://localhost:6380';
process.env.DATABASE_URL ||= 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';

const SUPER_URL = 'postgresql://tradepilot:tradepilot_dev@localhost:5432/tradepilot';
const APP_URL = 'postgresql://tradepilot_app:changeme_app@localhost:5432/tradepilot';

let superDb: Db;
let appDb: Db;
let redis: Redis;

let orgId = '';
let adminId = '';
let salesId = '';
let adminCtx: OrgScopeContext;
let salesCtx: OrgScopeContext;
let customers: CustomersService;

const adminEmail = `it-m5b1-${createId('org')}@test.com`;
const salesEmail = `it-m5b1-sales-${createId('org')}@test.com`;

async function expectBiz(promise: Promise<unknown>, code: number): Promise<void> {
  try {
    await promise;
  } catch (err: unknown) {
    expect(err).toBeInstanceOf(Object);
    expect((err as { code: number }).code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 BizException(${code}) 但未抛出`);
}

beforeAll(async () => {
  superDb = createDb(SUPER_URL, { max: 2 });
  appDb = createDb(APP_URL, { max: 5 });
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
  const env = new EnvService();
  const tokens = new TokenService(env, redis);
  const auth = new AuthService(appDb, tokens, redis);

  const session = await auth.register({
    companyName: 'IT M5 B1 租户',
    contactName: '管理员',
    email: adminEmail,
    password: 'password123',
  });
  orgId = session.user.orgId;
  adminId = session.user.userId;

  salesId = createId('usr');
  await superDb.insert(schema.userAccount).values({
    id: salesId,
    orgId,
    email: salesEmail,
    passwordHash: 'fixture_no_login',
    name: '销售乙',
    role: 'sales',
    status: 'active',
  });

  adminCtx = { orgId, userId: adminId, role: 'admin', scope: 'all' };
  salesCtx = { orgId, userId: salesId, role: 'sales', scope: 'self' };

  customers = new CustomersService(appDb);
}, 30_000);

afterAll(async () => {
  if (orgId) {
    await superDb.transaction(async (tx) => {
      await tx.delete(schema.approvalLog).where(eq(schema.approvalLog.orgId, orgId));
      await tx.delete(schema.approvalRequest).where(eq(schema.approvalRequest.orgId, orgId));
      await tx.delete(schema.llmCall).where(eq(schema.llmCall.orgId, orgId));
      await tx.delete(schema.aiTaskLog).where(eq(schema.aiTaskLog.orgId, orgId));
      await tx.delete(schema.aiTaskStep).where(eq(schema.aiTaskStep.orgId, orgId));
      await tx.delete(schema.aiTask).where(eq(schema.aiTask.orgId, orgId));
      await tx.delete(schema.followUpExecution).where(eq(schema.followUpExecution.orgId, orgId));
      await tx.delete(schema.followUpTask).where(eq(schema.followUpTask.orgId, orgId));
      await tx.delete(schema.followUpStrategyStep).where(eq(schema.followUpStrategyStep.orgId, orgId));
      await tx.delete(schema.followUpStrategy).where(eq(schema.followUpStrategy.orgId, orgId));
      await tx.delete(schema.conversationInsight).where(eq(schema.conversationInsight.orgId, orgId));
      await tx.delete(schema.message).where(eq(schema.message.orgId, orgId));
      await tx.delete(schema.conversation).where(eq(schema.conversation.orgId, orgId));
      await tx.delete(schema.customerInsight).where(eq(schema.customerInsight.orgId, orgId));
      await tx.delete(schema.customerActivity).where(eq(schema.customerActivity.orgId, orgId));
      await tx.delete(schema.contact).where(eq(schema.contact.orgId, orgId));
      await tx.delete(schema.customer).where(eq(schema.customer.orgId, orgId));
      await tx.delete(schema.aiLeadContact).where(eq(schema.aiLeadContact.orgId, orgId));
      await tx.delete(schema.aiLead).where(eq(schema.aiLead.orgId, orgId));
      await tx.delete(schema.aiEmployee).where(eq(schema.aiEmployee.orgId, orgId));
      await tx.delete(schema.sopTemplate).where(eq(schema.sopTemplate.orgId, orgId));
      await tx.delete(schema.aiModelSetting).where(eq(schema.aiModelSetting.orgId, orgId));
      await tx.delete(schema.rolePermission).where(eq(schema.rolePermission.orgId, orgId));
      await tx.delete(schema.userAccount).where(eq(schema.userAccount.orgId, orgId));
      await tx.delete(schema.org).where(eq(schema.org.id, orgId));
    });
  }
  await redis.quit();
  await closeDb(appDb);
  await closeDb(superDb);
});

// ============================== B1-1 软删 / batch-delete ==============================

describe('M5-B1-1 · 软删 & batch-delete（审批联动）', () => {
  let cusUnlocked = '';
  let cusLocked = '';

  beforeAll(async () => {
    // 非锁定态客户（直接删）
    cusUnlocked = (await customers.create(adminCtx, { companyName: 'B1 解锁客户 AG', country: 'Germany' })).customerId;
    // 锁定态客户（走审批）
    cusLocked = (await customers.create(adminCtx, { companyName: 'B1 锁定客户 GmbH', country: 'Germany' })).customerId;
    await superDb
      .update(schema.customer)
      .set({ deleteLocked: true })
      .where(eq(schema.customer.id, cusLocked));
  });

  it('非锁定态直接软删：deletedAt 设值，不产生审批', async () => {
    const result = await customers.delete(adminCtx, cusUnlocked);
    expect(result.approvalId).toBeUndefined();

    const [row] = await superDb
      .select({ deletedAt: schema.customer.deletedAt })
      .from(schema.customer)
      .where(eq(schema.customer.id, cusUnlocked));
    expect(row?.deletedAt).not.toBeNull();
  });

  it('锁定态走审批：deletedAt 设值 + approval_request 创建', async () => {
    const result = await customers.delete(adminCtx, cusLocked);
    expect(result.approvalId).toBeDefined();

    const [row] = await superDb
      .select({ deletedAt: schema.customer.deletedAt })
      .from(schema.customer)
      .where(eq(schema.customer.id, cusLocked));
    expect(row?.deletedAt).not.toBeNull();

    const [appr] = await superDb
      .select()
      .from(schema.approvalRequest)
      .where(eq(schema.approvalRequest.id, result.approvalId!));
    expect(appr).toBeDefined();
    expect(appr!.approvalType).toBe('customer_delete');
    expect(appr!.bizId).toBe(cusLocked);
    expect(appr!.status).toBe('pending');
  });

  it('sales 越权：无权限操作他人客户 → 40301', async () => {
    const [mine] = await superDb
      .select({ id: schema.customer.id })
      .from(schema.customer)
      .where(and(eq(schema.customer.orgId, orgId), eq(schema.customer.ownerId, salesId)))
      .limit(1);
    if (mine) {
      await expectBiz(customers.delete(salesCtx, mine.id), ErrorCode.FORBIDDEN);
    }
  });

  it('batch-delete 仅 manager/admin（sales 40301）', async () => {
    await expectBiz(
      customers.batchDelete(salesCtx, { customerIds: [cusLocked] }),
      ErrorCode.FORBIDDEN,
    );
  });
});

// ============================== B1-2 batch-owner ==============================

describe('M5-B1-2 · batch-owner 批量转交', () => {
  let cusA = '';
  let cusB = '';

  beforeAll(async () => {
    cusA = (await customers.create(adminCtx, { companyName: 'B1 转交客户 A', country: 'France' })).customerId;
    cusB = (await customers.create(adminCtx, { companyName: 'B1 转交客户 B', country: 'France' })).customerId;
  });

  it('manager/admin 批量转交 → ownerId 切换 + owner_change 活动留痕', async () => {
    const result = await customers.batchOwner(adminCtx, { ownerId: salesId, customerIds: [cusA, cusB] });
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.ownerId === salesId)).toBe(true);

    const [rowA] = await superDb
      .select({ ownerId: schema.customer.ownerId })
      .from(schema.customer)
      .where(eq(schema.customer.id, cusA));
    expect(rowA?.ownerId).toBe(salesId);

    const acts = await superDb
      .select()
      .from(schema.customerActivity)
      .where(
        and(
          eq(schema.customerActivity.orgId, orgId),
          eq(schema.customerActivity.type, 'owner_change'),
          inArray(schema.customerActivity.customerId, [cusA, cusB]),
        ),
      );
    expect(acts.length).toBe(2);
  });

  it('sales 越权 40301', async () => {
    await expectBiz(
      customers.batchOwner(salesCtx, { ownerId: adminId, customerIds: [cusA] }),
      ErrorCode.FORBIDDEN,
    );
  });

  it('待转交负责人不存在 → 404', async () => {
    await expectBiz(
      customers.batchOwner(adminCtx, { ownerId: 'usr_not_exist', customerIds: [cusA] }),
      ErrorCode.NOT_FOUND,
    );
  });
});

// ============================== B1-3 contacts CRUD ==============================

describe('M5-B1-3 · contacts CRUD', () => {
  let cusId = '';

  beforeAll(async () => {
    cusId = (await customers.create(adminCtx, { companyName: 'B1 联系人客户', country: 'Japan' })).customerId;
  });

  it('创建联系人', async () => {
    const result = await customers.createContact(adminCtx, cusId, {
      name: 'Taro',
      title: '课长',
      email: `taro-${createId('cont')}@example.com`,
      isPrimary: true,
    });
    expect(result.contactId).toBeDefined();

    const [row] = await superDb
      .select()
      .from(schema.contact)
      .where(eq(schema.contact.id, result.contactId));
    expect(row?.name).toBe('Taro');
    expect(row?.isPrimary).toBe(true);
  });

  it('编辑联系人', async () => {
    const [contact] = await superDb
      .select({ id: schema.contact.id })
      .from(schema.contact)
      .where(eq(schema.contact.customerId, cusId))
      .limit(1);
    expect(contact).toBeDefined();

    await customers.updateContact(adminCtx, cusId, contact!.id, { name: 'Taro Tanaka', isPrimary: false });
    const [row] = await superDb
      .select({ name: schema.contact.name, isPrimary: schema.contact.isPrimary })
      .from(schema.contact)
      .where(eq(schema.contact.id, contact!.id));
    expect(row?.name).toBe('Taro Tanaka');
    expect(row?.isPrimary).toBe(false);
  });

  it('删除单条联系人（不走审批）', async () => {
    // 创建一条临时联系人并删除
    const temp = await customers.createContact(adminCtx, cusId, { name: 'Temp', title: 'Temp' });
    await customers.deleteContact(adminCtx, cusId, temp.contactId);

    const [row] = await superDb
      .select({ id: schema.contact.id })
      .from(schema.contact)
      .where(eq(schema.contact.id, temp.contactId));
    expect(row).toBeUndefined();
  });

  it('联系人不存在 → 404', async () => {
    await expectBiz(
      customers.deleteContact(adminCtx, cusId, 'cont_not_exist'),
      ErrorCode.NOT_FOUND,
    );
  });

  it('sales 越权操作他人客户联系人 → 40301', async () => {
    await expectBiz(
      customers.createContact(salesCtx, cusId, { name: 'Hack', title: 'Bad' }),
      ErrorCode.FORBIDDEN,
    );
  });
});

// ============================== B1-4 activities 全局列表 ==============================

describe('M5-B1-4 · activities 全局列表', () => {
  let cusId = '';
  let adminOwnedCusId = '';

  beforeAll(async () => {
    cusId = (await customers.create(adminCtx, { companyName: 'B1 活动客户', country: 'UK' })).customerId;
    // 创建一些活动（stage_change / owner_change → 转给 sales）
    await customers.stage(adminCtx, cusId, { stage: 'contacted' });
    await customers.update(adminCtx, cusId, { ownerId: salesId });

    // 保留一个 admin 持有客户用于"不可见"测试
    adminOwnedCusId = (await customers.create(adminCtx, { companyName: 'B1 仅 admin 客户', country: 'UK' })).customerId;
    await customers.stage(adminCtx, adminOwnedCusId, { stage: 'contacted' });
  });

  it('全局列表：分页 + 字段完整（companyName/refType/refId）', async () => {
    const result = await customers.listActivities(adminCtx, { page: 1, pageSize: 20 });
    expect(result.items.length).toBeGreaterThanOrEqual(3);
    // 按 createdAt DESC 排序，最新活动排第一
    expect(result.items[0]!.refType).toBe('customer');
    expect(result.items.some((i) => i.companyName === 'B1 活动客户')).toBe(true);
    expect(result.items.some((i) => i.refId === cusId)).toBe(true);
  });

  it('type 筛选：仅 stage_change', async () => {
    const result = await customers.listActivities(adminCtx, { page: 1, pageSize: 20, type: 'stage_change' });
    expect(result.items.every((i) => i.type === 'stage_change')).toBe(true);
    expect(result.items.length).toBe(2); // 两个客户各有一个 stage_change
  });

  it('refType 筛选', async () => {
    const result = await customers.listActivities(adminCtx, { page: 1, pageSize: 20, refType: 'customer' });
    expect(result.total).toBeGreaterThanOrEqual(3);
  });

  it('scope 注入：sales(self) 看不到 admin 持有的客户活动', async () => {
    const result = await customers.listActivities(salesCtx, { page: 1, pageSize: 20 });
    // sales 只能看到 cusId（已转交给他）的活动，看不到 adminOwnedCusId 的活动
    expect(result.items.every((i) => i.customerId !== adminOwnedCusId)).toBe(true);
    expect(result.items.length).toBeGreaterThanOrEqual(2); // cusId 的活动(stage_change + owner_change)
  });

  it('scope 注入：sales(self) 只能看到自己客户的活动', async () => {
    const result = await customers.listActivities(salesCtx, { page: 1, pageSize: 20 });
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    // 所有结果都不应包含 admin 持有的客户的活动
    expect(result.items.every((i) => i.customerId !== adminOwnedCusId)).toBe(true);
  });
});