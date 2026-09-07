/**
 * 04 客户 360° 契约测试（04 接口文档 §2/§3 · 接口规范 §2）：
 * 覆盖双数据源 Profile（CRM/lead 预览）、Insights（Insight Schema）、
 * 异步分析、页签（联系人/产品/会话/活动）与 AI 生成开发信的 envelope 与字段结构。
 * 只读为主（analyze 幂等、outreach 产出草稿），无跨文件状态依赖。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/mocks/utils', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, LATENCY: 0 }
})

import { ErrorCode } from '@/api/error-codes'
import type {
  ActivityItem,
  ContactItem,
  ConversationItem,
  Customer360Insight,
  Customer360Profile,
  CustomerProductItem,
} from '@/api/types/customers'
import type { Insight } from '@/api/types/insight'
import type { PageResp } from '@/api/types/common'

import { api, contractServer, expectFail, expectOk, expectPage } from './_server'

beforeAll(() => contractServer.listen({ onUnhandledRequest: 'error' }))
afterEach(() => contractServer.resetHandlers())
afterAll(() => contractServer.close())

describe('GET /customers/:id Profile（04 §3.1，05 详情复用）', () => {
  it('CRM 客户：inCrm=true + 头部字段 + Overview（产品匹配行结构）', async () => {
    const { json } = await api<Customer360Profile>('/customers/cus_1')
    const profile = expectOk(json)
    expect(profile.customerId).toBe('cus_1')
    expect(profile.inCrm).toBe(true)
    expect(profile.companyName).toBeTruthy()
    expect(Array.isArray(profile.industryTags)).toBe(true)
    expect(typeof profile.score).toBe('number')
    // inCrm 主数据子集（可编辑/推进/删除的动作依据）
    for (const key of ['stage', 'ownerId', 'isFormal', 'deleteLocked']) {
      expect(key in profile, `缺少字段 ${key}`).toBe(true)
    }
    const matches = profile.overview.productMatches ?? []
    expect(matches.length).toBeGreaterThan(0)
    for (const m of matches) {
      expect(typeof m.matchPct).toBe('number')
      expect(m.productName).toBeTruthy()
    }
  })

  it('获客池 lead：inCrm=false 预览（仅 Overview/Contacts/Products）', async () => {
    const { json } = await api<Customer360Profile>('/customers/lead_4')
    const profile = expectOk(json)
    expect(profile.inCrm).toBe(false)
    expect(profile.overview).toBeTruthy()
  })

  it('不存在 → 40401 + data=null', async () => {
    const { json } = await api('/customers/cus-not-exist')
    expectFail(json, ErrorCode.NOT_FOUND)
  })
})

describe('Insights 契约（04 §3.2，Insight Schema）', () => {
  it('已有分析：purchaseProbability 含 value/confidence/reasons 证据链', async () => {
    const { json } = await api<Customer360Insight>('/customers/cus_1/insights')
    const data = expectOk(json)
    const prob = data.purchaseProbability as Insight<number>
    expect(prob).not.toBeNull()
    expect(typeof prob.value).toBe('number')
    expect(prob.confidence).toBeGreaterThan(0)
    expect(prob.confidence).toBeLessThanOrEqual(1)
    expect(Array.isArray(prob.reasons)).toBe(true)
    for (const r of prob.reasons ?? []) {
      expect(r.text).toBeTruthy()
      expect(r.evidence).toBeTruthy()
      expect(r.source).toBeTruthy()
    }
    expect(data.nextAction).not.toBeNull()
    expect(typeof data.nextAction!.label).toBe('string')
  })

  it('estimated=true 角标契约（基于估算数据必须可标记，00 §4.1）', async () => {
    const { json } = await api<Customer360Insight>('/customers/cus_4/insights')
    const data = expectOk(json)
    expect(data.purchaseProbability?.estimated).toBe(true)
  })

  it('未分析客户：null 值契约（前端据此引导重新分析，D9 兜底）', async () => {
    const { json } = await api<Customer360Insight>('/customers/cus_3/insights')
    const data = expectOk(json)
    expect(data.purchaseProbability).toBeNull()
    expect(data.nextAction).toBeNull()
  })
})

describe('POST /customers/:id/analyze 异步分析契约（04 §3.3）', () => {
  it('返回 taskId；进行中重复触发幂等复用同一任务', async () => {
    const first = await api<{ taskId: string }>('/customers/cus_2/analyze', {
      method: 'POST',
      body: JSON.stringify({ scope: 'full' }),
    })
    const t1 = expectOk(first.json)
    expect(typeof t1.taskId).toBe('string')
    const second = await api<{ taskId: string }>('/customers/cus_2/analyze', {
      method: 'POST',
      body: JSON.stringify({ scope: 'full' }),
    })
    expect(expectOk(second.json).taskId).toBe(t1.taskId)
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
    const { json } = await api<PageResp<ContactItem>>('/customers/cus_1/contacts')
    const p = expectPage<ContactItem>(expectOk(json))
    expect(p.total).toBeGreaterThan(0)
    expect('decisionInfluencePct' in p.list[0]).toBe(true)
  })

  it('Products：matchPct + 可选抽屉详情字段（D7 行内抽屉数据源）', async () => {
    const { json } = await api<CustomerProductItem[]>('/customers/cus_1/products')
    const list = expectOk(json)
    expect(list.length).toBeGreaterThan(0)
    for (const item of list) {
      expect(item.productId).toBeTruthy()
      expect(typeof item.matchPct).toBe('number')
    }
  })

  it('Conversations：分页 + ConversationItem 字段（06 行内预览口径）', async () => {
    const { json } = await api<PageResp<ConversationItem>>('/customers/cus_1/conversations')
    const p = expectPage<ConversationItem>(expectOk(json))
    expect(p.total).toBeGreaterThan(0)
    for (const key of ['conversationId', 'email', 'subject', 'lastMessageAt', 'unreadCount']) {
      expect(key in p.list[0], `缺少字段 ${key}`).toBe(true)
    }
  })

  it('Activities：分页 + type 过滤', async () => {
    const { json } = await api<PageResp<ActivityItem>>(
      '/customers/cus_1/activities?type=stage_change',
    )
    const p = expectPage<ActivityItem>(expectOk(json))
    expect(p.total).toBeGreaterThan(0)
    expect(p.list.every((a) => a.type === 'stage_change')).toBe(true)
  })
})

describe('POST /contacts/:id/generate-outreach 开发信契约（04 §3.4）', () => {
  it('产出草稿（不直接发送）：draftId + content', async () => {
    const { json } = await api<{ draftId: string; content: string }>(
      '/contacts/con_1/generate-outreach',
      { method: 'POST', body: JSON.stringify({ scenario: 'cold_outreach' }) },
    )
    const data = expectOk(json)
    expect(data.draftId).toBeTruthy()
    expect(typeof data.content).toBe('string')
    expect(data.content.length).toBeGreaterThan(0)
  })

  it('联系人不存在 → 40401', async () => {
    const { json } = await api('/contacts/con-not-exist/generate-outreach', {
      method: 'POST',
      body: JSON.stringify({ scenario: 'cold_outreach' }),
    })
    expectFail(json, ErrorCode.NOT_FOUND)
  })
})
