// @vitest-environment node
/**
 * 01 Dashboard 工作台契约测试（真实后端 · 01 接口文档 v0.2）：
 * 覆盖首屏聚合结构与 P0 降级行为（00 §5.1 D1~D3）：
 * - kpis 仅 new_customers/new_inquiries（未启用 metric 不返回而非返回 0）；
 * - pendingItems 仅 high_value_overdue/customer_reply；
 * - 无 dailyReport 字段；daily-report 两接口恒 40401。
 *
 * 运行前需启动后端；本文件在 beforeAll 注册独立 org。
 */
import { beforeAll, describe, expect, it } from 'vitest'

import { ErrorCode } from '@/api/error-codes'
import type { DashboardSummary } from '@/api/types/dashboard'

import { api, expectFail, expectOk, registerOrg } from './_server'

beforeAll(async () => {
  await registerOrg()
})

describe('GET /dashboard/summary 聚合契约（01 §3.1）', () => {
  it('envelope + 顶层区块字段齐全', async () => {
    const { json } = await api<DashboardSummary>('/dashboard/summary')
    const data = expectOk(json)
    for (const key of ['greeting', 'kpis', 'aiEmployees', 'highValueCustomers', 'pendingItems']) {
      expect(key in data, `缺少区块 ${key}`).toBe(true)
    }
  })

  it('D1：kpis 仅返回 new_customers/new_inquiries，每卡字段完整', async () => {
    const data = expectOk((await api<DashboardSummary>('/dashboard/summary')).json)
    const metrics = data.kpis.map((k) => k.metric)
    expect(metrics).toEqual(['new_customers', 'new_inquiries'])
    for (const kpi of data.kpis) {
      for (const key of ['metric', 'value', 'changePct', 'trend', 'comparePeriod']) {
        expect(key in kpi, `KPI 缺少字段 ${key}`).toBe(true)
      }
      expect(['up', 'down', 'flat']).toContain(kpi.trend)
    }
  })

  it('D2：pendingItems 仅 high_value_overdue/customer_reply，level/link 有效', async () => {
    const data = expectOk((await api<DashboardSummary>('/dashboard/summary')).json)
    const types = data.pendingItems.map((p) => p.type)
    expect(types).toEqual(['high_value_overdue', 'customer_reply'])
    for (const item of data.pendingItems) {
      expect(['danger', 'warning', 'info']).toContain(item.level)
      expect(item.link.startsWith('/')).toBe(true)
      expect(typeof item.count).toBe('number')
    }
  })

  it('D3：响应无 dailyReport 字段（入口隐藏，不渲染）', async () => {
    const { json } = await api<Record<string, unknown>>('/dashboard/summary')
    const data = expectOk(json)
    expect('dailyReport' in data).toBe(false)
  })

  it('FR-03：aiEmployees 字段完整（种子 6 名 AI 员工在场）', async () => {
    const data = expectOk((await api<DashboardSummary>('/dashboard/summary')).json)
    expect(data.aiEmployees.length).toBeGreaterThan(0)
    for (const employee of data.aiEmployees) {
      for (const key of ['employeeId', 'name', 'role', 'status', 'currentAction', 'todayOutput']) {
        expect(key in employee, `员工缺少字段 ${key}`).toBe(true)
      }
      expect(typeof employee.todayOutput.count).toBe('number')
    }
  })

  it('FR-04：highValueCustomers 行字段完整（新 org 可为空）', async () => {
    const data = expectOk((await api<DashboardSummary>('/dashboard/summary')).json)
    expect(Array.isArray(data.highValueCustomers)).toBe(true)
    for (const customer of data.highValueCustomers) {
      for (const key of ['customerId', 'companyName', 'score']) {
        expect(key in customer, `客户缺少字段 ${key}`).toBe(true)
      }
      expect(customer.score).toBeGreaterThanOrEqual(0)
      expect(customer.score).toBeLessThanOrEqual(100)
    }
  })
})

describe('daily-report 接口 P0 保留 40401（01 §3.2/§3.3 D3）', () => {
  it('GET /dashboard/daily-report → 40401', async () => {
    const { json } = await api('/dashboard/daily-report')
    expectFail(json, ErrorCode.NOT_FOUND)
  })

  it('POST /dashboard/daily-report/generate → 40401', async () => {
    const { json } = await api('/dashboard/daily-report/generate', {
      method: 'POST',
      body: JSON.stringify({ period: 'daily' }),
    })
    expectFail(json, ErrorCode.NOT_FOUND)
  })
})
