// @vitest-environment node
/**
 * 05 CRM 客户中心契约测试（真实后端 · 05 §1/§2/§3）：
 * 覆盖客户列表/增改/阶段机/删除审批/批量/联系人/活动时间线的
 * envelope、分页、错误码（40001/40401/40901）与关键字段结构。
 *
 * 运行前需启动后端；本文件在 beforeAll 注册独立 org 并通过 API 自建数据。
 * （ownerId 缺省即当前登录用户；转交类用例需同 org 多成员，故不在本文件覆盖。）
 */
import { beforeAll, describe, expect, it } from 'vitest'

import type { PageResp } from '@/api/types/common'
import type { ActivityItem, ContactItem, CustomerDetail, CustomerItem } from '@/api/types/customers'
import { ErrorCode } from '@/api/error-codes'

import { api, expectFail, expectOk, expectPage, registerOrg } from './_server'

const ALPHA = 'Contract Test Alpha'
const BETA = 'Contract Test Beta'
const GAMMA = 'Contract Test Gamma'

let userId = ''
let customerA!: CustomerDetail
let customerB!: CustomerDetail
let customerB2!: CustomerDetail
let contactA!: ContactItem

beforeAll(async () => {
  const org = await registerOrg()
  userId = org.userId

  const a = expectOk(
    (
      await api<{ customerId: string }>('/customers', {
        method: 'POST',
        body: JSON.stringify({
          companyName: ALPHA,
          country: 'US',
          contacts: [{ name: 'Lily Test', title: 'Buyer', email: 'lily@contract-test.com' }],
        }),
      })
    ).json,
  )
  customerA = expectOk((await api<CustomerDetail>(`/customers/${a.customerId}`)).json)

  const b = expectOk(
    (
      await api<{ customerId: string }>('/customers', {
        method: 'POST',
        body: JSON.stringify({ companyName: BETA, country: 'DE' }),
      })
    ).json,
  )
  customerB = expectOk((await api<CustomerDetail>(`/customers/${b.customerId}`)).json)

  const c = expectOk(
    (
      await api<{ customerId: string }>('/customers', {
        method: 'POST',
        body: JSON.stringify({ companyName: GAMMA, country: 'FR' }),
      })
    ).json,
  )
  customerB2 = expectOk((await api<CustomerDetail>(`/customers/${c.customerId}`)).json)
})

describe('GET /customers 列表契约（05 §3.1）', () => {
  it('统一 envelope + 分页结构 + 行字段对齐 CustomerItem', async () => {
    const { json } = await api<PageResp<CustomerItem>>('/customers')
    const page1 = expectPage<CustomerItem>(expectOk(json))
    expect(page1.total).toBeGreaterThanOrEqual(3)
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

  it('tab 过滤：potential 全部 isFormal=false；formal 全部 isFormal=true', async () => {
    const potential = expectOk((await api<PageResp<CustomerItem>>('/customers?tab=potential')).json)
    expect(potential.items.length).toBeGreaterThan(0)
    expect(potential.items.every((c) => c.isFormal === false)).toBe(true)
    const formal = expectOk((await api<PageResp<CustomerItem>>('/customers?tab=formal')).json)
    expect(formal.items.every((c) => c.isFormal === true)).toBe(true)
  })

  it('scope=self 只返回当前操作人名下客户；keyword 按公司名过滤', async () => {
    const self = expectOk((await api<PageResp<CustomerItem>>('/customers?scope=self')).json)
    expect(self.items.every((c) => c.ownerId === userId)).toBe(true)
    const kw = expectOk(
      (await api<PageResp<CustomerItem>>(`/customers?keyword=${encodeURIComponent(ALPHA)}`)).json,
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
  it('缺公司名/国家 → 40001', async () => {
    const missName = await api('/customers', {
      method: 'POST',
      body: JSON.stringify({ country: 'US' }),
    })
    expectFail(missName.json, ErrorCode.BAD_REQUEST)
    const missCountry = await api('/customers', {
      method: 'POST',
      body: JSON.stringify({ companyName: 'X Corp' }),
    })
    expectFail(missCountry.json, ErrorCode.BAD_REQUEST)
  })

  it('创建成功：默认值正确（潜在/new_lead/未锁定/归属本人）+ 联系人子表单落库', async () => {
    expect(customerA.isFormal).toBe(false)
    expect(customerA.stage).toBe('new_lead')
    expect(customerA.deleteLocked).toBe(false)
    expect(customerA.ownerId).toBe(userId)
    const contacts = expectOk((await api<PageResp<ContactItem>>('/contacts?keyword=lily')).json)
    expect(contacts.total).toBe(1)
    contactA = contacts.items[0]
    expect(contactA.customerId).toBe(customerA.customerId)
    expect(contactA.companyName).toBe(customerA.companyName)
  })

  it('公司名 org 内唯一：重复 → 40901', async () => {
    const dup = await api('/customers', {
      method: 'POST',
      body: JSON.stringify({ companyName: ALPHA, country: 'US' }),
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

  it('编辑成功：返回 customerId', async () => {
    const data = expectOk(
      (
        await api<{ customerId: string }>(`/customers/${customerA.customerId}`, {
          method: 'PUT',
          body: JSON.stringify({ remark: 'edited by contract test' }),
        })
      ).json,
    )
    expect(data.customerId).toBe(customerA.customerId)
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
    const data = expectOk(
      (
        await api<{ customerId: string; stage: string; activityId: string }>(
          `/customers/${customerA.customerId}/stage`,
          { method: 'POST', body: JSON.stringify({ stage: 'negotiation' }) },
        )
      ).json,
    )
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
    const data = expectOk(
      (
        await api<{ customerId: string; approvalId: string; approvalType: string; status: string }>(
          `/customers/${customerB.customerId}`,
          { method: 'DELETE' },
        )
      ).json,
    )
    expect(data.approvalType).toBe('customer_delete')
    expect(data.status).toBe('pending')
    const row = expectOk(
      (await api<PageResp<CustomerItem>>(`/customers?keyword=${encodeURIComponent(BETA)}`)).json,
    )
    expect(row.items[0].deleteLocked).toBe(true)
    const again = await api(`/customers/${customerB.customerId}`, { method: 'DELETE' })
    expectFail(again.json, ErrorCode.CONFLICT)
  })

  it('batch-delete：可删的生成审批，不存在/已锁定进 failed', async () => {
    const data = expectOk(
      (
        await api<{
          approvals: { customerId: string; approvalId: string }[]
          failed: { customerId: string; reason: string }[]
        }>('/customers/batch-delete', {
          method: 'POST',
          body: JSON.stringify({
            customerIds: [customerB2.customerId, 'cus-not-exist', customerB.customerId],
          }),
        })
      ).json,
    )
    expect(data.approvals.map((a) => a.customerId)).toEqual([customerB2.customerId])
    expect(data.failed.map((f) => f.customerId).sort()).toEqual(
      ['cus-not-exist', customerB.customerId].sort(),
    )
  })

  it('batch-owner：admin 批量改派返回 updated 数；目标负责人无效 → 失败', async () => {
    const data = expectOk(
      (
        await api<{ updated: number }>('/customers/batch-owner', {
          method: 'POST',
          body: JSON.stringify({ customerIds: [customerA.customerId], ownerId: userId }),
        })
      ).json,
    )
    expect(data.updated).toBe(1)
    const bad = await api('/customers/batch-owner', {
      method: 'POST',
      body: JSON.stringify({ customerIds: [customerA.customerId], ownerId: 'usr-not-exist' }),
    })
    expect([ErrorCode.BAD_REQUEST, ErrorCode.NOT_FOUND]).toContain(bad.json.code)
  })
})

describe('联系人契约（05 §1.3/§2）', () => {
  it('GET /contacts：分页结构 + ContactItem 字段', async () => {
    const p = expectPage<ContactItem>(
      expectOk((await api<PageResp<ContactItem>>('/contacts')).json),
    )
    expect(p.total).toBeGreaterThan(0)
    for (const key of ['contactId', 'name', 'email', 'customerId', 'companyName']) {
      expect(key in p.items[0], `缺少字段 ${key}`).toBe(true)
    }
  })

  it('POST 校验：缺姓名 → 40001；邮箱格式非法 → 40001；所属客户不存在 → 40401', async () => {
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

  it('POST 邮箱 org 内唯一 → 40901', async () => {
    const first = expectOk(
      (
        await api<{ contactId: string }>('/contacts', {
          method: 'POST',
          body: JSON.stringify({
            customerId: customerA.customerId,
            name: 'Dup One',
            email: 'dup@contract-test.com',
          }),
        })
      ).json,
    )
    expect(first.contactId).toBeTruthy()
    const second = await api('/contacts', {
      method: 'POST',
      body: JSON.stringify({
        customerId: customerA.customerId,
        name: 'Dup Two',
        email: 'DUP@contract-test.com',
      }),
    })
    expectFail(second.json, ErrorCode.CONFLICT)
  })

  it('PUT：排除自身后查重；显式空姓名 → 40001；不存在 → 40401', async () => {
    const keep = await api(`/contacts/${contactA.contactId}`, {
      method: 'PUT',
      body: JSON.stringify({ email: contactA.email, title: 'Senior Buyer' }),
    })
    expectOk(keep.json)
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
    const del = expectOk(
      (await api<{ contactId: string }>(`/contacts/${contactA.contactId}`, { method: 'DELETE' }))
        .json,
    )
    expect(del.contactId).toBe(contactA.contactId)
    const gone = expectOk((await api<PageResp<ContactItem>>('/contacts?keyword=lily')).json)
    expect(gone.total).toBe(0)
  })
})

describe('活动时间线契约（05 §3.4）', () => {
  it('分页结构 + ActivityItem 字段 + 最新优先排序', async () => {
    const p = expectPage<ActivityItem>(
      expectOk((await api<PageResp<ActivityItem>>('/activities')).json),
    )
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
    )
    expect(data.items.length).toBeGreaterThan(0)
    expect(data.items.every((a) => a.type === 'stage_change')).toBe(true)
    expect(data.items.every((a) => a.customerId === customerA.customerId)).toBe(true)
  })
})
