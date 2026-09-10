import { http, delay } from 'msw'

import { ErrorCode } from '@/api/error-codes'
import type { CustomerAnalyzeReq } from '@/api/types/customers'

import {
  analyze360,
  build360Profile,
  createOutreachDraft,
  customer360Activities,
  customer360ContactsPage,
  customer360Conversations,
  customer360Products,
  find360Contact,
  get360Insight,
} from '../data/customers360'
import { LATENCY, fail, ok, page, readJson } from '../utils'

/**
 * M4-3 客户 360°（04 接口文档 §2/§3；05 详情复用 04）：
 * - GET /customers/{id}：头部 + Overview（双数据源 customer/lead，inCrm=false 时 lead 预览）；
 * - 分析走异步任务（POST analyze → taskId，完成后 insights/联系人决策影响力更新）；
 * - 各页签为对应模块接口的客户维度过滤；AI 生成开发信产出草稿（04 §3.4，不直接发送）。
 */
export const customer360Handlers = [
  http.get('/api/v1/customers/:id', async ({ params }) => {
    await delay(LATENCY)
    const profile = build360Profile(String(params.id))
    if (!profile) return fail(ErrorCode.NOT_FOUND, '客户或线索不存在')
    return ok(profile)
  }),

  http.get('/api/v1/customers/:id/insights', async ({ params }) => {
    await delay(LATENCY)
    return ok(get360Insight(String(params.id)))
  }),

  http.post('/api/v1/customers/:id/analyze', async ({ request, params }) => {
    await delay(LATENCY)
    const raw = String(params.id)
    if (!build360Profile(raw)) return fail(ErrorCode.NOT_FOUND, '客户或线索不存在')
    const body = await readJson<CustomerAnalyzeReq>(request)
    const scope = body.scope === 'full' ? 'full' : 'overview'
    // 已有进行中分析任务则复用（幂等，04 §3.3）
    const taskId = analyze360(raw, scope)
    return ok({ taskId })
  }),

  http.get('/api/v1/customers/:id/contacts', async ({ request, params }) => {
    await delay(LATENCY)
    const url = new URL(request.url)
    const keyword = url.searchParams.get('keyword') ?? ''
    const pageNum = Number(url.searchParams.get('page') ?? 1)
    const pageSize = Number(url.searchParams.get('pageSize') ?? 20)
    const { items, total } = customer360ContactsPage(String(params.id), keyword, pageNum, pageSize)
    return ok(page(items, total, pageNum, pageSize))
  }),

  http.get('/api/v1/customers/:id/products', async ({ params }) => {
    await delay(LATENCY)
    return ok(customer360Products(String(params.id)))
  }),

  http.get('/api/v1/customers/:id/conversations', async ({ request, params }) => {
    await delay(LATENCY)
    const url = new URL(request.url)
    const pageNum = Number(url.searchParams.get('page') ?? 1)
    const pageSize = Number(url.searchParams.get('pageSize') ?? 20)
    const { items, total } = customer360Conversations(String(params.id), pageNum, pageSize)
    return ok(page(items, total, pageNum, pageSize))
  }),

  http.get('/api/v1/customers/:id/activities', async ({ request, params }) => {
    await delay(LATENCY)
    const url = new URL(request.url)
    const type = url.searchParams.get('type') ?? undefined
    const pageNum = Number(url.searchParams.get('page') ?? 1)
    const pageSize = Number(url.searchParams.get('pageSize') ?? 20)
    const { items, total } = customer360Activities(String(params.id), type, pageNum, pageSize)
    return ok(page(items, total, pageNum, pageSize))
  }),

  http.post('/api/v1/contacts/:id/generate-outreach', async ({ request, params }) => {
    await delay(LATENCY)
    const contactId = String(params.id)
    if (!find360Contact(contactId)) return fail(ErrorCode.NOT_FOUND, '联系人不存在')
    const body = await readJson<{ scenario?: 'cold_outreach' | 'quote_followup' }>(request)
    const scenario = body.scenario === 'quote_followup' ? 'quote_followup' : 'cold_outreach'
    return ok(createOutreachDraft(contactId, scenario))
  }),
]
