/**
 * 07 AI自动跟进契约测试（07 接口文档 §3 · 接口规范 §2）：
 * 覆盖总览统计/任务列表/暂停跳过/策略 CRUD/apply 应用/执行记录的
 * envelope、分页、错误码（40401/40901/42201）与关键字段结构。
 *
 * 测试顺序有状态依赖（同文件内共享 mock 内存态，vitest 文件间隔离）。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/mocks/utils', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, LATENCY: 0 }
})

import { ErrorCode } from '@/api/error-codes'
import type {
  ApplyStrategyResp,
  FollowUpExecution,
  FollowUpStrategy,
  FollowUpSummary,
  FollowUpTaskItem,
} from '@/api/types/follow-up'
import type { PageResp } from '@/api/types/common'

import { api, contractServer, expectFail, expectOk, expectPage } from './_server'

beforeAll(() => contractServer.listen({ onUnhandledRequest: 'error' }))
afterEach(() => contractServer.resetHandlers())
afterAll(() => contractServer.close())

describe('GET /follow-ups/summary 总览契约（07 §3.1）', () => {
  it('envelope + executingCount + 四 Tab 计数与任务列表一致', async () => {
    const { json } = await api<FollowUpSummary>('/follow-ups/summary')
    const data = expectOk(json)
    expect(typeof data.executingCount).toBe('number')
    for (const key of ['all', 'today', 'waitingApproval', 'completed']) {
      expect(key in data.tabs, `缺少 tabs.${key}`).toBe(true)
    }
    const tasks = expectOk((await api<PageResp<FollowUpTaskItem>>('/follow-up-tasks')).json)
    expect(data.tabs.all).toBe(tasks.total)
  })
})

describe('GET /follow-up-tasks 任务列表契约（07 §3.2）', () => {
  it('分页结构 + FollowUpTaskItem 字段（nextRunAt UTC 存储）', async () => {
    const { json } = await api<PageResp<FollowUpTaskItem>>('/follow-up-tasks')
    const p = expectPage<FollowUpTaskItem>(expectOk(json))
    expect(p.total).toBeGreaterThan(0)
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
      expect(key in p.items[0], `缺少字段 ${key}`).toBe(true)
    }
  })

  it('tab 过滤：waiting_approval 全部命中该状态；completed 同理', async () => {
    const waiting = expectOk(
      (await api<PageResp<FollowUpTaskItem>>('/follow-up-tasks?tab=waiting_approval')).json,
    )
    expect(waiting.items.length).toBeGreaterThan(0)
    expect(waiting.items.every((t) => t.status === 'waiting_approval')).toBe(true)
    const done = expectOk(
      (await api<PageResp<FollowUpTaskItem>>('/follow-up-tasks?tab=completed')).json,
    )
    expect(done.items.length).toBeGreaterThan(0)
    expect(done.items.every((t) => t.status === 'completed')).toBe(true)
  })

  it('keyword 按公司名过滤（大小写不敏感）', async () => {
    const data = expectOk(
      (await api<PageResp<FollowUpTaskItem>>('/follow-up-tasks?keyword=abc%20sports')).json,
    )
    expect(data.total).toBe(1)
    expect(data.items[0].companyName).toBe('ABC Sports')
  })
})

describe('POST /follow-up-tasks/:id/pause|skip 契约（07 §2）', () => {
  it('暂停 ready 任务：status=paused；已完成的任务 → 40901；不存在 → 40401', async () => {
    const { json } = await api<{ followUpTaskId: string; status: string }>(
      '/follow-up-tasks/ftask_1/pause',
      { method: 'POST' },
    )
    const data = expectOk(json)
    expect(data.followUpTaskId).toBe('ftask_1')
    expect(data.status).toBe('paused')

    const done = await api('/follow-up-tasks/ftask_7/pause', { method: 'POST' })
    expectFail(done.json, ErrorCode.CONFLICT)
    const missing = await api('/follow-up-tasks/ftask-not-exist/pause', { method: 'POST' })
    expectFail(missing.json, ErrorCode.NOT_FOUND)
  })

  it('跳过下一步：nextRunAt 顺延且晚于原值；已完成 → 40901', async () => {
    const before = expectOk(
      (await api<PageResp<FollowUpTaskItem>>('/follow-up-tasks?keyword=running%20pro')).json,
    )
    const prev = before.items[0].nextRunAt
    const { json } = await api<{ followUpTaskId: string; nextRunAt: string }>(
      '/follow-up-tasks/ftask_2/skip',
      { method: 'POST' },
    )
    const data = expectOk(json)
    expect(data.followUpTaskId).toBe('ftask_2')
    expect(new Date(data.nextRunAt).getTime()).toBeGreaterThan(new Date(prev).getTime())
    const done = await api('/follow-up-tasks/ftask_7/skip', { method: 'POST' })
    expectFail(done.json, ErrorCode.CONFLICT)
  })
})

describe('策略 CRUD 契约（07 §3.3/§7）', () => {
  it('GET 列表：默认策略种子在场（isDefault 不可删）', async () => {
    const { json } = await api<PageResp<FollowUpStrategy>>('/follow-up-strategies')
    const p = expectPage<FollowUpStrategy>(expectOk(json), { page: 1, pageSize: 50 })
    expect(p.total).toBeGreaterThanOrEqual(2)
    const def = p.items.find((s) => s.isDefault)
    expect(def?.strategyId).toBe('strat_1')
    expect(def?.steps.length).toBe(5)
    expect(def?.steps.some((s) => s.isBreakup)).toBe(true)
  })

  it('新建校验：空名称/空步骤/dayOffset 重复/不递增 → 42201；breakup + auto_send → 42201', async () => {
    const noName = await api('/follow-up-strategies', {
      method: 'POST',
      body: JSON.stringify({
        name: ' ',
        steps: [],
        targetScope: {},
        autoSendPolicy: 'manual_review',
        enabled: true,
      }),
    })
    expectFail(noName.json, ErrorCode.BIZ_VALIDATION)
    const dupDays = await api('/follow-up-strategies', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Dup Days',
        steps: [
          { seq: 1, dayOffset: 0, title: 'A', channel: 'email' },
          { seq: 2, dayOffset: 0, title: 'B', channel: 'email' },
        ],
        targetScope: {},
        autoSendPolicy: 'manual_review',
        enabled: true,
      }),
    })
    expectFail(dupDays.json, ErrorCode.BIZ_VALIDATION)
    const notAsc = await api('/follow-up-strategies', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Not Asc',
        steps: [
          { seq: 1, dayOffset: 5, title: 'A', channel: 'email' },
          { seq: 2, dayOffset: 3, title: 'B', channel: 'email' },
        ],
        targetScope: {},
        autoSendPolicy: 'manual_review',
        enabled: true,
      }),
    })
    expectFail(notAsc.json, ErrorCode.BIZ_VALIDATION)
    const breakupAuto = await api('/follow-up-strategies', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Breakup Auto',
        steps: [
          { seq: 1, dayOffset: 30, title: 'Break-up Email', channel: 'email', isBreakup: true },
        ],
        targetScope: {},
        autoSendPolicy: 'auto_send',
        enabled: true,
      }),
    })
    expectFail(breakupAuto.json, ErrorCode.BIZ_VALIDATION)
  })

  it('新建成功：steps 序号归一 + breakup 强制清 templateId；默认策略 PUT/DELETE → 40901', async () => {
    const created = expectOk(
      (
        await api<{ strategyId: string }>('/follow-up-strategies', {
          method: 'POST',
          body: JSON.stringify({
            name: '契约测试策略',
            steps: [
              { seq: 9, dayOffset: 0, title: 'Intro', templateId: 'tpl_intro', channel: 'email' },
              {
                seq: 3,
                dayOffset: 7,
                title: 'Break-up Email',
                content: 'bye',
                channel: 'email',
                isBreakup: true,
              },
            ],
            targetScope: { customerValue: ['high'] },
            autoSendPolicy: 'manual_review',
            enabled: true,
          }),
        })
      ).json,
    )
    expect(created.strategyId).toBe('strat_3')

    const list = expectOk((await api<PageResp<FollowUpStrategy>>('/follow-up-strategies')).json)
    const mine = list.items.find((s) => s.strategyId === created.strategyId)!
    expect(mine.steps.map((s) => s.seq)).toEqual([1, 2])
    expect(mine.steps[1].templateId).toBeUndefined()
    expect(mine.steps[1].isBreakup).toBe(true)

    const editDefault = await api('/follow-up-strategies/strat_1', {
      method: 'PUT',
      body: JSON.stringify({
        name: 'x',
        steps: [],
        targetScope: {},
        autoSendPolicy: 'manual_review',
        enabled: true,
      }),
    })
    expectFail(editDefault.json, ErrorCode.CONFLICT)
    const delDefault = await api('/follow-up-strategies/strat_1', { method: 'DELETE' })
    expectFail(delDefault.json, ErrorCode.CONFLICT)
  })

  it('编辑/删除自建策略：被引用 → 40901，未引用可删；不存在 → 40401', async () => {
    const put = await api<{ strategyId: string }>('/follow-up-strategies/strat_2', {
      method: 'PUT',
      body: JSON.stringify({
        name: '高价值客户重点培育 v2',
        steps: [{ seq: 1, dayOffset: 0, title: 'Warm Intro', content: 'hi', channel: 'email' }],
        targetScope: { customerValue: ['high'] },
        autoSendPolicy: 'manual_review',
        enabled: true,
      }),
    })
    expect(expectOk(put.json).strategyId).toBe('strat_2')

    const delInUse = await api('/follow-up-strategies/strat_2', { method: 'DELETE' })
    expectFail(delInUse.json, ErrorCode.CONFLICT)

    const created = expectOk(
      (
        await api<{ strategyId: string }>('/follow-up-strategies', {
          method: 'POST',
          body: JSON.stringify({
            name: '可删策略',
            steps: [{ seq: 1, dayOffset: 0, title: 'A', content: 'x', channel: 'email' }],
            targetScope: {},
            autoSendPolicy: 'manual_review',
            enabled: true,
          }),
        })
      ).json,
    )
    const del = await api<{ deleted: boolean }>(`/follow-up-strategies/${created.strategyId}`, {
      method: 'DELETE',
    })
    expect(expectOk(del.json).deleted).toBe(true)
    const missing = await api(`/follow-up-strategies/${created.strategyId}`, { method: 'DELETE' })
    expectFail(missing.json, ErrorCode.NOT_FOUND)
  })
})

describe('GET /follow-up-strategies/:id/executions 执行记录契约（07 §3.4）', () => {
  it('分页结构 + skipReason 留痕 + 最新优先排序', async () => {
    const { json } = await api<PageResp<FollowUpExecution>>(
      '/follow-up-strategies/strat_1/executions',
    )
    const p = expectPage<FollowUpExecution>(expectOk(json), { page: 1, pageSize: 50 })
    expect(p.total).toBeGreaterThan(0)
    for (const key of ['executionId', 'followUpTaskId', 'stepTitle', 'sentAt', 'status']) {
      expect(key in p.items[0], `缺少字段 ${key}`).toBe(true)
    }
    for (let i = 1; i < p.items.length; i++) {
      expect(p.items[i - 1].sentAt >= p.items[i].sentAt).toBe(true)
    }
    const skipped = p.items.filter((e) => e.status === 'skipped')
    expect(skipped.length).toBeGreaterThan(0)
    expect(
      skipped.every(
        (e) => e.skipReason === 'customer_replied' || e.skipReason === 'frequency_capped',
      ),
    ).toBe(true)
  })

  it('策略不存在 → 40401', async () => {
    const { json } = await api('/follow-up-strategies/strat-not-exist/executions')
    expectFail(json, ErrorCode.NOT_FOUND)
  })
})

describe('POST /follow-up-strategies/:id/apply 应用契约（07 §3.5）', () => {
  it('应用成功：created + skipped(task_exists)；无进行中任务才创建', async () => {
    // strat_3 在上一用例已被删除，重建一个未引用策略
    const created = expectOk(
      (
        await api<{ strategyId: string }>('/follow-up-strategies', {
          method: 'POST',
          body: JSON.stringify({
            name: 'Apply 契约策略',
            steps: [{ seq: 1, dayOffset: 0, title: 'Intro', content: 'hi', channel: 'email' }],
            targetScope: {},
            autoSendPolicy: 'manual_review',
            enabled: true,
          }),
        })
      ).json,
    )
    // cus_3（waiting_approval，进行中）→ skipped；cus_lead_3（CRM 种子线索）无任务 → created
    const { json } = await api<ApplyStrategyResp>(
      `/follow-up-strategies/${created.strategyId}/apply`,
      {
        method: 'POST',
        body: JSON.stringify({ customerIds: ['cus_3', 'cus_lead_3'] }),
      },
    )
    const data = expectOk(json)
    expect(data.created.map((c) => c.customerId)).toEqual(['cus_lead_3'])
    expect(data.created[0].followUpTaskId).toBeTruthy()
    expect(data.skipped).toEqual([{ customerId: 'cus_3', reason: 'task_exists' }])

    const tasks = expectOk(
      (await api<PageResp<FollowUpTaskItem>>('/follow-up-tasks?tab=all&keyword=')).json,
    )
    const row = tasks.items.find((t) => t.followUpTaskId === data.created[0].followUpTaskId)
    expect(row?.strategyId).toBe(created.strategyId)
    expect(row?.status === 'ready' || row?.status === 'scheduled').toBe(true)
  })

  it('customerIds 为空 → 40001；策略不存在 → 40401；客户不存在 → 40001', async () => {
    const empty = await api('/follow-up-strategies/strat_2/apply', {
      method: 'POST',
      body: JSON.stringify({ customerIds: [] }),
    })
    expectFail(empty.json, ErrorCode.BAD_REQUEST)
    const noStrategy = await api('/follow-up-strategies/strat-not-exist/apply', {
      method: 'POST',
      body: JSON.stringify({ customerIds: ['cus_1'] }),
    })
    expectFail(noStrategy.json, ErrorCode.NOT_FOUND)
    const noCustomer = await api('/follow-up-strategies/strat_2/apply', {
      method: 'POST',
      body: JSON.stringify({ customerIds: ['cus-not-exist'] }),
    })
    expectFail(noCustomer.json, ErrorCode.BAD_REQUEST)
  })
})
