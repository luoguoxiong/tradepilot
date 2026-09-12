// @vitest-environment node
/**
 * 04 客户 360° 契约测试（真实后端 · 04 §2/§3）：
 * 覆盖 Profile 结构、Insights 归一、异步分析幂等与页签（联系人/产品/会话/活动）。
 *
 * 运行前需启动后端；本文件注册独立 org 并通过 API 自建客户
 * （真实后端无预置线索/客户数据，故不做 lead 预览态与预置洞察断言）。
 */
import { beforeAll, describe, expect, it } from 'vitest'

import type { PageResp } from '@/api/types/common'
import type {
  ActivityItem,
  ContactItem,
  ConversationItem,
  Customer360Insight,
  Customer360Profile,
  CustomerProductItem,
} from '@/api/types/customers'
import { ErrorCode } from '@/api/error-codes'

import { api, expectFail, expectOk, expectPage, registerOrg, uniq } from './_server'

let customerId = ''

beforeAll(async () => {
  await registerOrg()
  customerId = expectOk(
    (
      await api<{ customerId: string }>('/customers', {
        method: 'POST',
        body: JSON.stringify({
          companyName: `Customer360 ${uniq()}`,
          country: 'US',
          contacts: [{ name: 'C360 Contact', email: `${uniq('c360')}@example.com` }],
        }),
      })
    ).json,
  ).customerId
})

describe('GET /customers/:id Profile（04 §3.1，05 详情复用）', () => {
  it('CRM 客户：inCrm=true + 头部字段完整', async () => {
    const profile = expectOk((await api<Customer360Profile>(`/customers/${customerId}`)).json)
    expect(profile.customerId).toBe(customerId)
    expect(profile.inCrm).toBe(true)
    expect(profile.companyName).toBeTruthy()
    expect(Array.isArray(profile.industryTags)).toBe(true)
    expect(typeof profile.score).toBe('number')
    for (const key of ['stage', 'ownerId', 'isFormal', 'deleteLocked']) {
      expect(key in profile, `缺少字段 ${key}`).toBe(true)
    }
  })

  it('不存在 → 40401', async () => {
    const { json } = await api('/customers/cus-not-exist')
    expectFail(json, ErrorCode.NOT_FOUND)
  })
})

describe('Insights 契约（04 §3.2，Insight Schema）', () => {
  it('未分析客户：null 值契约（前端据此引导重新分析，D9 兜底）', async () => {
    const data = expectOk((await api<Customer360Insight>(`/customers/${customerId}/insights`)).json)
    expect(data.purchaseProbability).toBeNull()
    expect(data.nextAction).toBeNull()
  })
})

describe('POST /customers/:id/analyze 异步分析契约（04 §3.3）', () => {
  it('返回 taskId；进行中重复触发幂等复用同一任务', async () => {
    const t1 = expectOk(
      (
        await api<{ taskId: string }>(`/customers/${customerId}/analyze`, {
          method: 'POST',
          body: JSON.stringify({ scope: 'full' }),
        })
      ).json,
    )
    expect(typeof t1.taskId).toBe('string')
    const t2 = expectOk(
      (
        await api<{ taskId: string }>(`/customers/${customerId}/analyze`, {
          method: 'POST',
          body: JSON.stringify({ scope: 'full' }),
        })
      ).json,
    )
    expect(t2.taskId).toBe(t1.taskId)
  })

  it('不存在 → 40401', async () => {
    const { json } = await api('/customers/cus-not-exist/analyze', {
      method: 'POST',
      body: JSON.stringify({ scope: 'overview' }),
    })
    expectFail(json, ErrorCode.NOT_FOUND)
  })
})

describe('页签接口契约（04 §1.4/§1.5）', () => {
  it('Contacts：分页 + decisionInfluencePct 字段', async () => {
    const p = expectPage<ContactItem>(
      expectOk((await api<PageResp<ContactItem>>(`/customers/${customerId}/contacts`)).json),
    )
    expect(p.total).toBeGreaterThan(0)
    expect('decisionInfluencePct' in p.items[0]).toBe(true)
  })

  it('Products：matchPct 字段（可为空列表）', async () => {
    const list = expectOk(
      (await api<CustomerProductItem[]>(`/customers/${customerId}/products`)).json,
    )
    expect(Array.isArray(list)).toBe(true)
    for (const item of list) {
      expect(item.productId).toBeTruthy()
      expect(typeof item.matchPct).toBe('number')
    }
  })

  it('Conversations：分页 + ConversationItem 字段（新 org 可为空）', async () => {
    const p = expectPage<ConversationItem>(
      expectOk(
        (await api<PageResp<ConversationItem>>(`/customers/${customerId}/conversations`)).json,
      ),
    )
    expect(typeof p.total).toBe('number')
    for (const key of ['conversationId', 'email', 'subject', 'lastMessageAt', 'unreadCount']) {
      if (p.items[0]) expect(key in p.items[0], `缺少字段 ${key}`).toBe(true)
    }
  })

  it('Activities：分页结构', async () => {
    const p = expectPage<ActivityItem>(
      expectOk((await api<PageResp<ActivityItem>>(`/customers/${customerId}/activities`)).json),
    )
    expect(typeof p.total).toBe('number')
  })
})
