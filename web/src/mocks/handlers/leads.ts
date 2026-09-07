import { http, delay } from 'msw'

import { ErrorCode } from '@/api/error-codes'
import type { LeadListReq } from '@/api/types/leads'

import { mockMembers } from '../data/db'
import {
  createLeadHuntTask,
  mockEmployees,
  mockLeads,
  mockTasks,
  refreshEmployeeCards,
  taskSnapshot,
} from '../data/business'
import { createCustomerFromLead, findCustomerByName } from '../data/customers'
import { LATENCY, fail, ok, page, readJson } from '../utils'

/** 当前演示会话用户（与 auth mock 对齐：admin，具备指派权限） */
const CURRENT_USER_ID = 'u-demo'

function hunterEmployee() {
  return mockEmployees.find((e) => e.role === 'lead_hunter') ?? mockEmployees[0]
}

/** 03-AI获客：工作台头部 / 目标解析 / 创建任务 / 发现列表 / 加入 CRM */
export const leadHandlers = [
  http.get('/api/v1/lead-hunter/summary', async () => {
    await delay(LATENCY)
    refreshEmployeeCards()
    const employee = hunterEmployee()
    const currentTask = employee.currentTask
    const running = currentTask ? mockTasks.get(currentTask.taskId) : undefined
    return ok({
      employee: {
        employeeId: employee.employeeId,
        name: employee.name,
        status: employee.status,
        statusDetail: employee.statusDetail,
      },
      todaySummary: {
        found: mockLeads.length,
        analyzed: mockLeads.length,
        highValue: mockLeads.filter((l) => l.scoreLevel === 'high').length,
      },
      currentTask:
        currentTask && running
          ? {
              taskId: currentTask.taskId,
              goal: running.goal,
              progressPct: currentTask.progressPct,
              foundCount: taskSnapshot(running).foundCount,
              targetCount: running.targetCount,
              currentStep: currentTask.currentStep ?? '',
              status: currentTask.status,
            }
          : null,
    })
  }),

  http.post('/api/v1/lead-tasks/parse', async ({ request }) => {
    await delay(900)
    const body = await readJson<{ goalText?: string }>(request)
    const text = body.goalText ?? ''
    // 演示级解析：市场关键词识别 + 默认画像（真实链路为 LLM 结构化输出）
    const MARKETS: [string, string][] = [
      ['美国', 'USA'],
      ['USA', 'USA'],
      ['德国', 'DE'],
      ['Germany', 'DE'],
      ['英国', 'UK'],
      ['UK', 'UK'],
      ['澳大利亚', 'AU'],
      ['Australia', 'AU'],
    ]
    const hit = MARKETS.find(([kw]) => text.includes(kw))
    const marketLabel = hit ? hit[0] : '美国'
    return ok({
      parsed: {
        targetMarket: hit ? hit[1] : 'USA',
        customerType: 'Shoe Brand',
        targetProduct: 'Carbon Fiber Insoles',
        companySize: '50-500+',
      },
      optimizedGoal: `寻找${marketLabel}主营跑鞋/运动鞋类的中大型品牌，匹配碳纤维鞋垫产品线`,
      confidence: 0.9,
      reasons: [{ text: '识别到市场+行业+产品三要素' }],
    })
  }),

  http.post('/api/v1/lead-tasks', async ({ request }) => {
    await delay(LATENCY)
    const body = await readJson<{
      goalText?: string
      parsed?: { targetMarket: string; customerType: string; targetProduct: string }
      targetCount?: number
      employeeId?: string
    }>(request)
    if (!body.goalText || !body.parsed?.targetMarket || !body.parsed?.targetProduct) {
      return fail(ErrorCode.BAD_REQUEST, '请完善目标描述与结构化字段')
    }
    const task = createLeadHuntTask({
      goalText: body.goalText,
      parsed: body.parsed,
      targetCount: body.targetCount,
      employeeId: body.employeeId,
    })
    refreshEmployeeCards()
    return ok({ taskId: task.taskId, status: task.status })
  }),

  http.get('/api/v1/leads/summary', async () => {
    await delay(150)
    return ok({
      all: mockLeads.length,
      high: mockLeads.filter((l) => l.scoreLevel === 'high').length,
      medium: mockLeads.filter((l) => l.scoreLevel === 'medium').length,
      low: mockLeads.filter((l) => l.scoreLevel === 'low').length,
      inCrm: mockLeads.filter((l) => l.inCrm).length,
    })
  }),

  http.get('/api/v1/leads', async ({ request }) => {
    await delay(LATENCY)
    const url = new URL(request.url)
    const valueLevel = url.searchParams.get('valueLevel') as LeadListReq['valueLevel']
    const keyword = url.searchParams.get('keyword') ?? undefined
    const country = url.searchParams.get('country') ?? undefined
    const inCrmParam = url.searchParams.get('inCrm')
    const pageNum = Number(url.searchParams.get('page') ?? 1)
    const pageSize = Number(url.searchParams.get('pageSize') ?? 20)

    let items = [...mockLeads]
    if (valueLevel && valueLevel !== 'all') items = items.filter((l) => l.scoreLevel === valueLevel)
    if (keyword) {
      const kw = keyword.toLowerCase()
      items = items.filter((l) => l.companyName.toLowerCase().includes(kw))
    }
    if (country) items = items.filter((l) => l.country === country)
    if (inCrmParam) items = items.filter((l) => l.inCrm === (inCrmParam === 'true'))

    return ok(
      page(
        items.slice((pageNum - 1) * pageSize, pageNum * pageSize),
        items.length,
        pageNum,
        pageSize,
      ),
    )
  }),

  http.post('/api/v1/leads/add-to-crm', async ({ request }) => {
    await delay(LATENCY)
    const body = await readJson<{ leadIds?: string[]; ownerId?: string }>(request)
    const leadIds = body.leadIds ?? []
    if (leadIds.length === 0) return fail(ErrorCode.BAD_REQUEST, '请选择要加入 CRM 的客户')

    // ownerId 指派契约（03 §3.4 / 05 §7）：业务员指定他人 → 40301；
    // 演示会话为 admin 可指派，但目标负责人必须存在
    if (body.ownerId && body.ownerId !== CURRENT_USER_ID) {
      const member = mockMembers.find((m) => m.memberId === body.ownerId)
      if (!member)
        return fail(ErrorCode.FORBIDDEN, '负责人不存在或无权限指派（业务员不可指派他人）')
    }

    const created: { customerId: string; leadId: string }[] = []
    const mapped: { leadId: string; mappedCustomerId: string }[] = []
    let duplicated = 0
    // 新建客户归属：未指定负责人默认操作人（03 §3.4）
    const ownerId =
      body.ownerId && body.ownerId !== CURRENT_USER_ID ? body.ownerId : CURRENT_USER_ID

    for (const leadId of leadIds) {
      const item = mockLeads.find((l) => l.leadId === leadId)
      if (!item) continue
      if (item.inCrm) {
        duplicated += 1
        continue
      }
      // 加入 CRM = 客户中心落库（05 §7 同库口径）：
      // 命中已有客户公司名 → 置 in_crm 并返回真实映射，不新建（03 §3.4 v0.2 去重口径）
      const existing = findCustomerByName(item.companyName)
      item.inCrm = true
      if (existing) {
        mapped.push({ leadId: item.leadId, mappedCustomerId: existing.customerId })
        continue
      }
      const newCustomer = createCustomerFromLead(item, ownerId)
      created.push({ customerId: newCustomer.customerId, leadId: item.leadId })
    }

    return ok({ created: created.length, duplicated, customers: created, mapped })
  }),

  http.post('/api/v1/leads/:id/convert', async ({ params }) => {
    await delay(LATENCY)
    const leadId = String(params.id)
    const item = mockLeads.find((l) => l.leadId === leadId)
    if (!item) return fail(ErrorCode.NOT_FOUND, '线索不存在')
    // 加入 CRM（04 §2 / 05 §7 同库口径）：命中已有客户公司名 → 归并映射，否则新建
    const existing = findCustomerByName(item.companyName)
    item.inCrm = true
    if (existing) {
      return ok({
        leadId,
        customerId: existing.customerId,
        customerName: existing.companyName,
        mapped: true,
      })
    }
    const created = createCustomerFromLead(item, CURRENT_USER_ID)
    return ok({
      leadId,
      customerId: created.customerId,
      customerName: created.companyName,
      mapped: false,
    })
  }),

  http.post('/api/v1/leads/batch-analyze', async ({ request }) => {
    await delay(600)
    await readJson<{ leadIds?: string[] }>(request)
    // 异步任务模式（03 §3.5）：返回 taskId，产出写入客户 360°（M4 交付）
    const task = createLeadHuntTask({
      goalText: '批量 AI 分析所选客户',
      parsed: { targetMarket: 'USA', customerType: 'Selected Leads', targetProduct: 'Insight' },
      targetCount: 0,
      employeeId: 'emp_2',
      seedLeads: false,
    })
    return ok({ taskId: task.taskId })
  }),
]
