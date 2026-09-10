/**
 * 05 CRM 客户中心契约测试（05 接口文档 §1/§2/§3 · 接口规范 §2）：
 * 覆盖客户列表/增改/阶段机/删除审批/批量/联系人/活动时间线的
 * envelope、分页、错误码（40001/40401/40901）与关键字段结构。
 *
 * 测试顺序有状态依赖（同文件内共享 mock 内存态，vitest 文件间隔离）。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/mocks/utils', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, LATENCY: 0 }
})

import { ErrorCode } from '@/api/error-codes'
import type { ActivityItem, ContactItem, CustomerDetail, CustomerItem } from '@/api/types/customers'
import type { PageResp } from '@/api/types/common'

import { api, contractServer, expectFail, expectOk, expectPage } from './_server'

beforeAll(() => contractServer.listen({ onUnhandledRequest: 'error' }))
afterEach(() => contractServer.resetHandlers())
afterAll(() => contractServer.close())

// ---- 流程共享态：beforeAll 建三个客户（C_A 带联系人；C_B/C_B2 供删除/批量）----
let customerA!: CustomerDetail
let customerB!: CustomerDetail
let customerB2!: CustomerDetail
let contactA!: ContactItem

beforeEach(async () => {
  if (customerA) return
  const r1 = await api<CustomerDetail>('/customers', {
    method: 'POST',
    body: JSON.stringify({
      companyName: 'Contract Test Alpha',
      country: 'US',
      ownerId: 'u-demo',
      contacts: [{ name: 'Lily Test', title: 'Buyer', email: 'lily@contract-test.com' }],
    }),
  })
  customerA = expectOk(r1.json)
  const r2 = await api<CustomerDetail>('/customers', {
    method: 'POST',
    body: JSON.stringify({ companyName: 'Contract Test Beta', country: 'DE', ownerId: 'u-demo' }),
  })
  customerB = expectOk(r2.json)
  const r3 = await api<CustomerDetail>('/customers', {
    method: 'POST',
    body: JSON.stringify({ companyName: 'Contract Test Gamma', country: 'FR', ownerId: 'u-demo' }),
  })
  customerB2 = expectOk(r3.json)
})

describe('GET /customers 列表契约（05 §3.1）', () => {
  it('统一 envelope + 分页结构 + 行字段对齐 CustomerItem', async () => {
    const { json } = await api<PageResp<CustomerItem>>('/customers')
    const data = expectOk(json)
    const page1 = expectPage<CustomerItem>(data)
    expect(page1.total).toBeGreaterThanOrEqual(4)
    const row = page1.items[0]
    for (const key of [
      'customerId',
      'companyName',
      'country',
      'stage',
      'isFormal',
      'ownerId',
      'ownerName',
      'deleteLocked',
      'createdAt',
    ]) {
      expect(key in row, `缺少字段 ${key}`).toBe(true)
    }
    expect(typeof row.isFormal).toBe('boolean')
    expect(typeof row.deleteLocked).toBe('boolean')
  })

  it('tab 过滤：potential 全部 isFormal=false，formal 全部 isFormal=true', async () => {
    const potential = expectOk((await api<PageResp<CustomerItem>>('/customers?tab=potential')).json)
    expect(potential.items.length).toBeGreaterThan(0)
    expect(potential.items.every((c) => c.isFormal === false)).toBe(true)
    const formal = expectOk((await api<PageResp<CustomerItem>>('/customers?tab=formal')).json)
    expect(formal.items.length).toBeGreaterThan(0)
    expect(formal.items.every((c) => c.isFormal === true)).toBe(true)
  })

  it('scope=self 只返回当前操作人名下客户；keyword 按公司名过滤', async () => {
    const self = expectOk((await api<PageResp<CustomerItem>>('/customers?scope=self')).json)
    expect(self.items.every((c) => c.ownerId === 'u-demo')).toBe(true)
    const kw = expectOk(
      (await api<PageResp<CustomerItem>>('/customers?keyword=contract%20test%20alpha')).json,
    )
    expect(kw.total).toBe(1)
    expect(kw.items[0].customerId).toBe(customerA.customerId)
  })

  it('分页参数回显：page/pageSize 与切片一致', async () => {
    const data = expectOk((await api<PageResp<CustomerItem>>('/customers?page=1&pageSize=2')).json)
    const p = expectPage<CustomerItem>(data, { page: 1, pageSize: 2 })
    expect(p.items.length).toBeLessThanOrEqual(2)
  })
})

describe('POST /customers 添加客户契约（05 §1.2）', () => {
  it('缺公司名称/国家 → 40001；缺负责人 → 40001', async () => {
    const missName = await api('/customers', {
      method: 'POST',
      body: JSON.stringify({ country: 'US', ownerId: 'u-demo' }),
    })
    expectFail(missName.json, ErrorCode.BAD_REQUEST)
    const missOwner = await api('/customers', {
      method: 'POST',
      body: JSON.stringify({ companyName: 'X Corp', country: 'US' }),
    })
    expectFail(missOwner.json, ErrorCode.BAD_REQUEST)
  })

  it('创建成功：默认值正确（潜在/new_lead/未锁定）+ 联系人子表单落库', async () => {
    expect(customerA.isFormal).toBe(false)
    expect(customerA.stage).toBe('new_lead')
    expect(customerA.deleteLocked).toBe(false)
    expect(customerA.ownerId).toBe('u-demo')
    expect(customerA.ownerName).toBe('演示管理员')
    const contacts = expectOk(
      (await api<PageResp<ContactItem>>('/contacts?keyword=lily%20test')).json,
    )
    expect(contacts.total).toBe(1)
    contactA = contacts.items[0]
    expect(contactA.customerId).toBe(customerA.customerId)
    expect(contactA.companyName).toBe(customerA.companyName)
  })

  it('公司名 org 内唯一：重复 → 40901', async () => {
    const dup = await api('/customers', {
      method: 'POST',
      body: JSON.stringify({
        companyName: 'Contract Test Alpha',
        country: 'US',
        ownerId: 'u-demo',
      }),
    })
    expectFail(dup.json, ErrorCode.CONFLICT)
  })
})

describe('PUT /customers/:id 编辑契约（05 §3.2）', () => {
  it('客户不存在 → 40401', async () => {
    const { json } = await api('/customers/cus-not-exist', {
      method: 'PUT',
      body: JSON.stringify({ remark: 'x' }),
    })
    expectFail(json, ErrorCode.NOT_FOUND)
  })

  it('改 ownerId 即转交（admin 允许）：ownerName 联动 + 写 owner_change 活动', async () => {
    const before = expectOk((await api<CustomerDetail>(`/customers/${customerA.customerId}`)).json)
    const updated = expectOk(
      (
        await api<CustomerDetail>(`/customers/${customerA.customerId}`, {
          method: 'PUT',
          body: JSON.stringify({ ownerId: 'm-1' }),
        })
      ).json,
    )
    expect(updated.ownerId).toBe('m-1')
    expect(updated.ownerName).toBe('张三')
    expect(updated.ownerName).not.toBe(before.ownerName)
    const acts = expectOk(
      (
        await api<PageResp<ActivityItem>>(
          `/activities?customerId=${customerA.customerId}&type=owner_change`,
        )
      ).json,
    )
    expect(acts.items.length).toBeGreaterThan(0)
    expect(acts.items[0].operatorType).toBe('user')
  })

  it('删除锁定客户不可编辑 → 40901（种子 cus_8 已锁定）', async () => {
    const { json } = await api('/customers/cus_8', {
      method: 'PUT',
      body: JSON.stringify({ remark: 'x' }),
    })
    expectFail(json, ErrorCode.CONFLICT)
  })
})

describe('POST /customers/:id/stage 阶段机契约（05 §3.2）', () => {
  it('非法阶段值 → 40001', async () => {
    const { json } = await api(`/customers/${customerA.customerId}/stage`, {
      method: 'POST',
      body: JSON.stringify({ stage: 'hacked' }),
    })
    expectFail(json, ErrorCode.BAD_REQUEST)
  })

  it('正向推进成功：返回 stage + activityId', async () => {
    const { json } = await api<{ customerId: string; stage: string; activityId: string }>(
      `/customers/${customerA.customerId}/stage`,
      {
        method: 'POST',
        body: JSON.stringify({ stage: 'negotiation' }),
      },
    )
    const data = expectOk(json)
    expect(data.customerId).toBe(customerA.customerId)
    expect(data.stage).toBe('negotiation')
    expect(data.activityId).toBeTruthy()
  })

  it('回退到 contacted 允许；跳回 new_lead → 40901', async () => {
    const rollback = await api(`/customers/${customerA.customerId}/stage`, {
      method: 'POST',
      body: JSON.stringify({ stage: 'contacted' }),
    })
    expect(rollback.json.code).toBe(0)
    const invalid = await api(`/customers/${customerA.customerId}/stage`, {
      method: 'POST',
      body: JSON.stringify({ stage: 'new_lead' }),
    })
    expectFail(invalid.json, ErrorCode.CONFLICT)
  })
})

describe('删除客户 → 审批契约（05 §3.3/§3.5）', () => {
  it('DELETE 不直接删除：生成 customer_delete 审批 + 行置锁定；重复删除 → 40901', async () => {
    const { json } = await api<{ approvalId: string; approvalType: string; status: string }>(
      `/customers/${customerB.customerId}`,
      { method: 'DELETE' },
    )
    const data = expectOk(json)
    expect(data.approvalType).toBe('customer_delete')
    expect(data.status).toBe('pending')
    const row = expectOk(
      (await api<PageResp<CustomerItem>>(`/customers?keyword=contract%20test%20beta`)).json,
    )
    expect(row.items[0].deleteLocked).toBe(true)
    const again = await api(`/customers/${customerB.customerId}`, { method: 'DELETE' })
    expectFail(again.json, ErrorCode.CONFLICT)
  })

  it('batch-delete：可删的生成审批，不存在/已锁定进 failed', async () => {
    const { json } = await api<{
      approvals: { customerId: string; approvalId: string }[]
      failed: { customerId: string; reason: string }[]
    }>('/customers/batch-delete', {
      method: 'POST',
      body: JSON.stringify({
        customerIds: [customerB2.customerId, 'cus-not-exist', customerB.customerId],
      }),
    })
    const data = expectOk(json)
    expect(data.approvals.map((a) => a.customerId)).toEqual([customerB2.customerId])
    expect(data.failed.map((f) => f.customerId)).toEqual(['cus-not-exist', customerB.customerId])
  })

  it('batch-owner：admin 批量改派返回 updated 数；目标负责人不存在 → 40001', async () => {
    const { json } = await api<{ updated: number }>('/customers/batch-owner', {
      method: 'POST',
      body: JSON.stringify({ customerIds: [customerA.customerId], ownerId: 'm-2' }),
    })
    const data = expectOk(json)
    expect(data.updated).toBe(1)
    const bad = await api('/customers/batch-owner', {
      method: 'POST',
      body: JSON.stringify({ customerIds: [customerA.customerId], ownerId: 'm-not-exist' }),
    })
    expectFail(bad.json, ErrorCode.BAD_REQUEST)
  })
})

describe('联系人契约（05 §1.3/§2）', () => {
  it('GET /contacts：分页结构 + ContactItem 字段', async () => {
    const { json } = await api<PageResp<ContactItem>>('/contacts')
    const data = expectOk(json)
    const p = expectPage<ContactItem>(data)
    expect(p.total).toBeGreaterThan(0)
    for (const key of ['contactId', 'name', 'email', 'customerId', 'companyName']) {
      expect(key in p.items[0], `缺少字段 ${key}`).toBe(true)
    }
  })

  it('POST 校验：缺姓名/邮箱格式非法 → 40001；所属客户不存在 → 40401', async () => {
    const noName = await api('/contacts', {
      method: 'POST',
      body: JSON.stringify({ customerId: customerA.customerId, email: 'a@b.com' }),
    })
    expectFail(noName.json, ErrorCode.BAD_REQUEST)
    const badEmail = await api('/contacts', {
      method: 'POST',
      body: JSON.stringify({ customerId: customerA.customerId, name: 'X', email: 'not-an-email' }),
    })
    expectFail(badEmail.json, ErrorCode.BAD_REQUEST)
    const noCustomer = await api('/contacts', {
      method: 'POST',
      body: JSON.stringify({ customerId: 'cus-not-exist', name: 'X' }),
    })
    expectFail(noCustomer.json, ErrorCode.NOT_FOUND)
  })

  it('POST 邮箱 org 内唯一 → 40901（ER uq_contact_org_email，POST/PUT 同口径）', async () => {
    const first = await api<ContactItem>('/contacts', {
      method: 'POST',
      body: JSON.stringify({
        customerId: customerA.customerId,
        name: 'Dup One',
        email: 'dup@contract-test.com',
      }),
    })
    const created = expectOk(first.json)
    const second = await api('/contacts', {
      method: 'POST',
      body: JSON.stringify({
        customerId: customerA.customerId,
        name: 'Dup Two',
        email: 'DUP@contract-test.com',
      }),
    })
    expectFail(second.json, ErrorCode.CONFLICT)
    expect(created.contactId).toBeTruthy()
  })

  it('PUT：排除自身后查重；显式空姓名 → 40001；不存在 → 40401', async () => {
    const keep = await api<ContactItem>(`/contacts/${contactA.contactId}`, {
      method: 'PUT',
      body: JSON.stringify({ email: 'lily@contract-test.com', title: 'Senior Buyer' }),
    })
    expectOk(keep.json)
    expect(keep.json.data.title).toBe('Senior Buyer')
    const emptyName = await api(`/contacts/${contactA.contactId}`, {
      method: 'PUT',
      body: JSON.stringify({ name: '  ' }),
    })
    expectFail(emptyName.json, ErrorCode.BAD_REQUEST)
    const missing = await api('/contacts/con-not-exist', {
      method: 'PUT',
      body: JSON.stringify({ title: 'x' }),
    })
    expectFail(missing.json, ErrorCode.NOT_FOUND)
  })

  it('DELETE：返回 contactId 且列表不再命中', async () => {
    const { json } = await api<{ contactId: string }>(`/contacts/${contactA.contactId}`, {
      method: 'DELETE',
    })
    expect(expectOk(json).contactId).toBe(contactA.contactId)
    const gone = expectOk((await api<PageResp<ContactItem>>('/contacts?keyword=lily%20test')).json)
    expect(gone.total).toBe(0)
  })
})

describe('活动时间线契约（05 §3.4）', () => {
  it('分页结构 + ActivityItem 字段 + 最新优先排序', async () => {
    const { json } = await api<PageResp<ActivityItem>>('/activities')
    const p = expectPage<ActivityItem>(expectOk(json))
    expect(p.total).toBeGreaterThan(0)
    for (const key of [
      'activityId',
      'type',
      'summary',
      'operatorType',
      'operatorName',
      'createdAt',
    ]) {
      expect(key in p.items[0], `缺少字段 ${key}`).toBe(true)
    }
    for (let i = 1; i < p.items.length; i++) {
      expect(p.items[i - 1].createdAt >= p.items[i].createdAt).toBe(true)
    }
  })

  it('type/customerId 过滤生效', async () => {
    const data = expectOk(
      (
        await api<PageResp<ActivityItem>>(
          `/activities?type=stage_change&customerId=${customerA.customerId}`,
        )
      ).json,
    ) as PageResp<ActivityItem>
    expect(data.items.length).toBeGreaterThan(0)
    expect(data.items.every((a) => a.type === 'stage_change')).toBe(true)
    expect(data.items.every((a) => a.customerId === customerA.customerId)).toBe(true)
  })
})
