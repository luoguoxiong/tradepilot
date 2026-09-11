// @vitest-environment node
/**
 * 07 AI自动跟进契约测试（真实后端 · 07 §2/§3/§7）：
 * 覆盖总览统计/任务列表/策略 CRUD/apply 应用/执行记录的
 * envelope、分页、错误码（40001/40401/40901/42201）与关键字段结构。
 *
 * 运行前需启动后端；本文件注册独立 org（含默认跟进策略种子），
 * 任务/执行记录类用例通过 POST /follow-up-strategies/{id}/apply 自建。
 */
import { beforeAll, describe, expect, it } from 'vitest'

import type { PageResp } from '@/api/types/common'
import type {
  ApplyStrategyResp,
  FollowUpExecution,
  FollowUpStrategy,
  FollowUpSummary,
  FollowUpTaskItem,
} from '@/api/types/follow-up'
import { ErrorCode } from '@/api/error-codes'

import { api, expectFail, expectOk, expectPage, registerOrg, uniq } from './_server'

let customer1 = ''
let customer2 = ''
let defaultStrategyId = ''
let createdStrategyId = ''

beforeAll(async () => {
  await registerOrg()
  customer1 = expectOk(
    (
      await api<{ customerId: string }>('/customers', {
        method: 'POST',
        body: JSON.stringify({ companyName: `Follow One ${uniq()}`, country: 'US' }),
      })
    ).json,
  ).customerId
  customer2 = expectOk(
    (
      await api<{ customerId: string }>('/customers', {
        method: 'POST',
        body: JSON.stringify({ companyName: `Follow Two ${uniq()}`, country: 'DE' }),
      })
    ).json,
  ).customerId
})

describe('GET /follow-ups/summary 总览契约（07 §3.1）', () => {
  it('envelope + executingCount + 四 Tab 计数与任务列表一致', async () => {
    const data = expectOk((await api<FollowUpSummary>('/follow-ups/summary')).json)
    expect(typeof data.executingCount).toBe('number')
    for (const key of ['all', 'today', 'waitingApproval', 'completed']) {
      expect(key in data.tabs, `缺少 tabs.${key}`).toBe(true)
    }
    const tasks = expectOk((await api<PageResp<FollowUpTaskItem>>('/follow-up-tasks')).json)
    expect(data.tabs.all).toBe(tasks.total)
  })
})

describe('GET /follow-up-tasks 任务列表契约（07 §3.2）', () => {
  it('分页结构 + FollowUpTaskItem 字段（新 org 可为空）', async () => {
    const p = expectPage<FollowUpTaskItem>(
      expectOk((await api<PageResp<FollowUpTaskItem>>('/follow-up-tasks')).json),
    )
    expect(typeof p.total).toBe('number')
    for (const row of p.items) {
      for (const key of [
        'followUpTaskId',
        'customerId',
        'companyName',
        'currentStage',
        'nextRunAt',
        'status',
        'strategyId',
        'strategyName',
      ]) {
        expect(key in row, `缺少字段 ${key}`).toBe(true)
      }
    }
  })
})

describe('策略 CRUD 契约（07 §3.3/§7）', () => {
  it('GET 列表：默认策略种子在场（isDefault，5 步含 break-up）', async () => {
    const p = expectPage<FollowUpStrategy>(
      expectOk((await api<PageResp<FollowUpStrategy>>('/follow-up-strategies?pageSize=50')).json),
      { page: 1, pageSize: 50 },
    )
    expect(p.total).toBeGreaterThanOrEqual(1)
    const def = p.items.find((s) => s.isDefault)
    expect(def).toBeTruthy()
    defaultStrategyId = def!.strategyId
    expect(def!.steps.length).toBe(5)
    expect(def!.steps.some((s) => s.isBreakup)).toBe(true)
  })

  it('新建校验：空名称/空步骤/dayOffset 重复/不递增 → 42201；breakup + auto_send → 42201', async () => {
    const base = { targetScope: {}, autoSendPolicy: 'manual_review', enabled: true }
    const noName = await api('/follow-up-strategies', {
      method: 'POST',
      body: JSON.stringify({ ...base, name: ' ', steps: [{ seq: 1, dayOffset: 0, title: 'A' }] }),
    })
    expectFail(noName.json, ErrorCode.BIZ_VALIDATION)
    const noSteps = await api('/follow-up-strategies', {
      method: 'POST',
      body: JSON.stringify({ ...base, name: 'No Steps', steps: [] }),
    })
    expectFail(noSteps.json, ErrorCode.BIZ_VALIDATION)
    const dupDays = await api('/follow-up-strategies', {
      method: 'POST',
      body: JSON.stringify({
        ...base,
        name: 'Dup Days',
        steps: [
          { seq: 1, dayOffset: 0, title: 'A' },
          { seq: 2, dayOffset: 0, title: 'B' },
        ],
      }),
    })
    expectFail(dupDays.json, ErrorCode.BIZ_VALIDATION)
    const notAsc = await api('/follow-up-strategies', {
      method: 'POST',
      body: JSON.stringify({
        ...base,
        name: 'Not Asc',
        steps: [
          { seq: 1, dayOffset: 5, title: 'A' },
          { seq: 2, dayOffset: 3, title: 'B' },
        ],
      }),
    })
    expectFail(notAsc.json, ErrorCode.BIZ_VALIDATION)
    const breakupAuto = await api('/follow-up-strategies', {
      method: 'POST',
      body: JSON.stringify({
        ...base,
        name: 'Breakup Auto',
        autoSendPolicy: 'auto_send',
        steps: [{ seq: 1, dayOffset: 30, title: 'Break-up', isBreakup: true }],
      }),
    })
    expectFail(breakupAuto.json, ErrorCode.BIZ_VALIDATION)
  })

  it('新建成功：steps 序号归一 + breakup 强制清 templateId；默认策略 PUT/DELETE → 40901', async () => {
    createdStrategyId = expectOk(
      (
        await api<{ strategyId: string }>('/follow-up-strategies', {
          method: 'POST',
          body: JSON.stringify({
            name: `契约测试策略 ${uniq()}`,
            steps: [
              { seq: 9, dayOffset: 0, title: 'Intro', templateId: 'tpl_intro' },
              { seq: 3, dayOffset: 7, title: 'Break-up Email', content: 'bye', isBreakup: true },
            ],
            targetScope: {},
            autoSendPolicy: 'manual_review',
            enabled: true,
          }),
        })
      ).json,
    ).strategyId
    expect(createdStrategyId).toBeTruthy()

    const list = expectOk(
      (await api<PageResp<FollowUpStrategy>>('/follow-up-strategies?pageSize=100')).json,
    )
    const mine = list.items.find((s) => s.strategyId === createdStrategyId)!
    expect(mine.steps.map((s) => s.seq)).toEqual([1, 2])
    expect(mine.steps[1].templateId).toBeUndefined()
    expect(mine.steps[1].isBreakup).toBe(true)

    const editDefault = await api(`/follow-up-strategies/${defaultStrategyId}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: 'x',
        steps: [{ seq: 1, dayOffset: 0, title: 'A' }],
        targetScope: {},
        autoSendPolicy: 'manual_review',
        enabled: true,
      }),
    })
    expectFail(editDefault.json, ErrorCode.CONFLICT)
    const delDefault = await api(`/follow-up-strategies/${defaultStrategyId}`, { method: 'DELETE' })
    expectFail(delDefault.json, ErrorCode.CONFLICT)
  })

  it('删除自建未引用策略：deleted=true；再删 → 40401', async () => {
    const created = expectOk(
      (
        await api<{ strategyId: string }>('/follow-up-strategies', {
          method: 'POST',
          body: JSON.stringify({
            name: `可删策略 ${uniq()}`,
            steps: [{ seq: 1, dayOffset: 0, title: 'A', content: 'x' }],
            targetScope: {},
            autoSendPolicy: 'manual_review',
            enabled: true,
          }),
        })
      ).json,
    )
    const del = expectOk(
      (
        await api<{ deleted: boolean }>(`/follow-up-strategies/${created.strategyId}`, {
          method: 'DELETE',
        })
      ).json,
    )
    expect(del.deleted).toBe(true)
    const missing = await api(`/follow-up-strategies/${created.strategyId}`, { method: 'DELETE' })
    expectFail(missing.json, ErrorCode.NOT_FOUND)
  })
})

describe('GET /follow-up-strategies/:id/executions 执行记录契约（07 §3.4）', () => {
  it('分页结构（新 org 可为空）；策略不存在 → 40401', async () => {
    const p = expectPage<FollowUpExecution>(
      expectOk(
        (
          await api<PageResp<FollowUpExecution>>(
            `/follow-up-strategies/${defaultStrategyId}/executions?pageSize=50`,
          )
        ).json,
      ),
      { page: 1, pageSize: 50 },
    )
    expect(typeof p.total).toBe('number')
    for (const key of ['executionId', 'followUpTaskId', 'stepTitle', 'sentAt', 'status']) {
      if (p.items[0]) expect(key in p.items[0], `缺少字段 ${key}`).toBe(true)
    }
    const { json } = await api('/follow-up-strategies/strat-not-exist/executions')
    expectFail(json, ErrorCode.NOT_FOUND)
  })
})

describe('POST /follow-up-strategies/:id/apply 应用契约（07 §3.5）', () => {
  it('应用成功：created；重复应用同客户 → skipped(task_exists)；可 pause', async () => {
    const data = expectOk(
      (
        await api<ApplyStrategyResp>(`/follow-up-strategies/${createdStrategyId}/apply`, {
          method: 'POST',
          body: JSON.stringify({ customerIds: [customer1] }),
        })
      ).json,
    )
    expect(data.created.map((c) => c.customerId)).toEqual([customer1])
    const taskId = data.created[0].followUpTaskId
    expect(taskId).toBeTruthy()
    expect(data.skipped).toEqual([])

    const tasks = expectOk(
      (await api<PageResp<FollowUpTaskItem>>('/follow-up-tasks?tab=all&pageSize=100')).json,
    )
    expect(tasks.items.find((t) => t.followUpTaskId === taskId)?.strategyId).toBe(createdStrategyId)

    const again = expectOk(
      (
        await api<ApplyStrategyResp>(`/follow-up-strategies/${createdStrategyId}/apply`, {
          method: 'POST',
          body: JSON.stringify({ customerIds: [customer1] }),
        })
      ).json,
    )
    expect(again.skipped).toEqual([{ customerId: customer1, reason: 'task_exists' }])

    const paused = expectOk(
      (
        await api<{ followUpTaskId: string; status: string }>(`/follow-up-tasks/${taskId}/pause`, {
          method: 'POST',
        })
      ).json,
    )
    expect(paused.followUpTaskId).toBe(taskId)
    expect(paused.status).toBe('paused')
  })

  it('skip：nextRunAt 顺延且晚于原值', async () => {
    const applied = expectOk(
      (
        await api<ApplyStrategyResp>(`/follow-up-strategies/${createdStrategyId}/apply`, {
          method: 'POST',
          body: JSON.stringify({ customerIds: [customer2] }),
        })
      ).json,
    )
    const taskId = applied.created[0].followUpTaskId
    const before = expectOk(
      (await api<PageResp<FollowUpTaskItem>>('/follow-up-tasks?tab=all&pageSize=100')).json,
    )
    const prev = before.items.find((t) => t.followUpTaskId === taskId)!.nextRunAt
    const data = expectOk(
      (
        await api<{ followUpTaskId: string; nextRunAt: string }>(
          `/follow-up-tasks/${taskId}/skip`,
          { method: 'POST' },
        )
      ).json,
    )
    expect(data.followUpTaskId).toBe(taskId)
    expect(new Date(data.nextRunAt).getTime()).toBeGreaterThan(new Date(prev).getTime())
  })

  it('customerIds 为空 → 40001；策略不存在 → 40401；客户不存在 → 40001', async () => {
    const empty = await api(`/follow-up-strategies/${defaultStrategyId}/apply`, {
      method: 'POST',
      body: JSON.stringify({ customerIds: [] }),
    })
    expectFail(empty.json, ErrorCode.BAD_REQUEST)
    const noStrategy = await api('/follow-up-strategies/strat-not-exist/apply', {
      method: 'POST',
      body: JSON.stringify({ customerIds: [customer1] }),
    })
    expectFail(noStrategy.json, ErrorCode.NOT_FOUND)
    const noCustomer = await api(`/follow-up-strategies/${defaultStrategyId}/apply`, {
      method: 'POST',
      body: JSON.stringify({ customerIds: ['cus-not-exist'] }),
    })
    expectFail(noCustomer.json, ErrorCode.BAD_REQUEST)
  })
})
