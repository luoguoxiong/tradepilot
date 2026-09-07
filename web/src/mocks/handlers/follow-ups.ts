import { http, delay } from 'msw'

import { ErrorCode } from '@/api/error-codes'
import type {
  ApplyStrategyReq,
  FollowUpStrategy,
  StrategyStep,
  UpsertStrategyReq,
} from '@/api/types/follow-up'

import {
  hasOngoingTask,
  isStrategyInUse,
  mockExecutions,
  mockFollowUpTasks,
  mockStrategies,
  nextStrategyId,
  nextTaskId,
} from '../data/follow-ups'
import { mockCustomers } from '../data/customers'
import { LATENCY, fail, ok, page, readJson } from '../utils'

/** 企业当地日历日（org.timezone=Asia/Shanghai，「今天待执行」口径，07 §4） */
function localDateKey(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(iso))
}

/** 策略保存校验（07 §3.3）：名称必填 / 至少 1 步 / dayOffset 唯一且递增 / breakup 禁 auto_send */
function validateStrategy(body: Partial<UpsertStrategyReq>): string | null {
  if (!body.name || !body.name.trim()) return '策略名称必填'
  const steps = body.steps ?? []
  if (steps.length === 0) return '至少配置一个跟进步骤'
  const days = steps.map((s: StrategyStep) => s.dayOffset)
  if (new Set(days).size !== days.length) return 'Day 偏移不可重复'
  for (let i = 1; i < days.length; i += 1) {
    if (days[i] <= days[i - 1]) return 'Day 偏移必须递增'
  }
  const hasBreakup = steps.some((s: StrategyStep) => s.isBreakup)
  if (hasBreakup && body.autoSendPolicy === 'auto_send') {
    return 'Break-up Email 节点强制人工审核，不可选择自动发送'
  }
  return null
}

function sanitizeSteps(steps: StrategyStep[]): StrategyStep[] {
  return steps.map((step, index) => ({
    ...step,
    seq: index + 1,
    // is_breakup 由系统置位并强制人工审核（07 §2.1 设计说明 4）
    isBreakup: Boolean(step.isBreakup),
    templateId: step.isBreakup ? undefined : step.templateId,
    content: step.isBreakup || !step.templateId ? step.content : undefined,
    channel: 'email' as const,
  }))
}

export const followUpHandlers = [
  // ===== 3.1 总览统计 =====
  http.get('/api/v1/follow-ups/summary', async () => {
    await delay(LATENCY)
    const todayKey = localDateKey(new Date().toISOString())
    const tabs = {
      all: mockFollowUpTasks.length,
      today: mockFollowUpTasks.filter((t) => localDateKey(t.nextRunAt) === todayKey).length,
      waitingApproval: mockFollowUpTasks.filter((t) => t.status === 'waiting_approval').length,
      completed: mockFollowUpTasks.filter((t) => t.status === 'completed').length,
    }
    const executingCount = mockFollowUpTasks.filter(
      (t) => t.status !== 'completed' && t.status !== 'paused',
    ).length
    return ok({ executingCount, tabs })
  }),

  // ===== 3.2 任务列表 =====
  http.get('/api/v1/follow-up-tasks', async ({ request }) => {
    await delay(LATENCY)
    const url = new URL(request.url)
    const tab = url.searchParams.get('tab') ?? 'all'
    const keyword = (url.searchParams.get('keyword') ?? '').toLowerCase()
    const pageNum = Number(url.searchParams.get('page') ?? 1)
    const pageSize = Number(url.searchParams.get('pageSize') ?? 20)

    const todayKey = localDateKey(new Date().toISOString())
    let items = [...mockFollowUpTasks]
    if (tab === 'today') items = items.filter((t) => localDateKey(t.nextRunAt) === todayKey)
    else if (tab === 'waiting_approval') items = items.filter((t) => t.status === 'waiting_approval')
    else if (tab === 'completed') items = items.filter((t) => t.status === 'completed')
    if (keyword) {
      items = items.filter((t) => t.companyName.toLowerCase().includes(keyword))
    }
    return ok(page(items, items.length, pageNum, pageSize))
  }),

  // ===== 暂停 / 跳过（07 §2：客户回复自动暂停 / 跳过下一步） =====
  http.post('/api/v1/follow-up-tasks/:taskId/pause', async ({ params }) => {
    await delay(LATENCY)
    const task = mockFollowUpTasks.find((t) => t.followUpTaskId === params.taskId)
    if (!task) return fail(ErrorCode.NOT_FOUND, '跟进任务不存在')
    if (task.status === 'completed') return fail(ErrorCode.CONFLICT, '已完成的任务不可暂停')
    task.status = 'paused'
    return ok({ followUpTaskId: task.followUpTaskId, status: 'paused' })
  }),

  http.post('/api/v1/follow-up-tasks/:taskId/skip', async ({ params }) => {
    await delay(LATENCY)
    const task = mockFollowUpTasks.find((t) => t.followUpTaskId === params.taskId)
    if (!task) return fail(ErrorCode.NOT_FOUND, '跟进任务不存在')
    if (task.status === 'completed') return fail(ErrorCode.CONFLICT, '已完成的任务不可跳过')
    task.nextRunAt = new Date(new Date(task.nextRunAt).getTime() + 24 * 3_600_000).toISOString()
    return ok({ followUpTaskId: task.followUpTaskId, nextRunAt: task.nextRunAt })
  }),

  // ===== 3.3 策略列表 / 新建 =====
  http.get('/api/v1/follow-up-strategies', async () => {
    await delay(LATENCY)
    return ok(page(mockStrategies, mockStrategies.length, 1, 50))
  }),

  http.post('/api/v1/follow-up-strategies', async ({ request }) => {
    await delay(LATENCY)
    const body = await readJson<UpsertStrategyReq>(request)
    const error = validateStrategy(body)
    if (error) return fail(ErrorCode.BIZ_VALIDATION, error)
    const strategy: FollowUpStrategy = {
      strategyId: nextStrategyId(),
      name: body.name!.trim(),
      targetScope: body.targetScope ?? { customerValue: [] },
      steps: sanitizeSteps(body.steps!),
      autoSendPolicy: body.autoSendPolicy ?? 'manual_review',
      enabled: body.enabled ?? true,
      createdAt: new Date().toISOString(),
    }
    mockStrategies.push(strategy)
    return ok({ strategyId: strategy.strategyId })
  }),

  // ===== 编辑 / 删除 =====
  http.put('/api/v1/follow-up-strategies/:strategyId', async ({ request, params }) => {
    await delay(LATENCY)
    const strategy = mockStrategies.find((s) => s.strategyId === params.strategyId)
    if (!strategy) return fail(ErrorCode.NOT_FOUND, '策略不存在')
    if (strategy.isDefault) {
      return fail(ErrorCode.CONFLICT, '默认策略不可直接修改，请复制后编辑')
    }
    const body = await readJson<UpsertStrategyReq>(request)
    const error = validateStrategy(body)
    if (error) return fail(ErrorCode.BIZ_VALIDATION, error)
    strategy.name = body.name!.trim()
    strategy.targetScope = body.targetScope ?? { customerValue: [] }
    strategy.steps = sanitizeSteps(body.steps!)
    strategy.autoSendPolicy = body.autoSendPolicy ?? 'manual_review'
    strategy.enabled = body.enabled ?? strategy.enabled
    return ok({ strategyId: strategy.strategyId })
  }),

  http.delete('/api/v1/follow-up-strategies/:strategyId', async ({ params }) => {
    await delay(LATENCY)
    const index = mockStrategies.findIndex((s) => s.strategyId === params.strategyId)
    if (index === -1) return fail(ErrorCode.NOT_FOUND, '策略不存在')
    if (mockStrategies[index].isDefault) return fail(ErrorCode.CONFLICT, '默认策略不可删除')
    if (isStrategyInUse(mockStrategies[index].strategyId)) {
      return fail(ErrorCode.CONFLICT, '策略正在被进行中任务引用，不可删除')
    }
    mockStrategies.splice(index, 1)
    return ok({ deleted: true })
  }),

  // ===== 3.4 执行记录 =====
  http.get('/api/v1/follow-up-strategies/:strategyId/executions', async ({ params }) => {
    await delay(LATENCY)
    const strategy = mockStrategies.find((s) => s.strategyId === params.strategyId)
    if (!strategy) return fail(ErrorCode.NOT_FOUND, '策略不存在')
    const taskIds = new Set(
      mockFollowUpTasks.filter((t) => t.strategyId === strategy.strategyId).map((t) => t.followUpTaskId),
    )
    const items = mockExecutions
      .filter((e) => taskIds.has(e.followUpTaskId))
      .sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1))
    return ok(page(items, items.length, 1, 50))
  }),

  // ===== 3.5 应用策略到客户（单选/批量；无进行中任务才创建） =====
  http.post('/api/v1/follow-up-strategies/:strategyId/apply', async ({ request, params }) => {
    await delay(LATENCY)
    const strategy = mockStrategies.find((s) => s.strategyId === params.strategyId)
    if (!strategy) return fail(ErrorCode.NOT_FOUND, '策略不存在')
    const body = await readJson<ApplyStrategyReq>(request)
    if (!body.customerIds?.length) return fail(ErrorCode.BAD_REQUEST, 'customerIds 不能为空')

    const created: Array<{ customerId: string; followUpTaskId: string }> = []
    const skipped: Array<{ customerId: string; reason: 'task_exists' }> = []
    for (const customerId of body.customerIds) {
      const customer = mockCustomers.find((c) => c.customerId === customerId)
      if (!customer) return fail(ErrorCode.BAD_REQUEST, `客户 ${customerId} 不存在`)
      if (hasOngoingTask(customerId)) {
        skipped.push({ customerId, reason: 'task_exists' })
        continue
      }
      const firstDay = strategy.steps[0]?.dayOffset ?? 0
      const taskId = nextTaskId()
      mockFollowUpTasks.push({
        followUpTaskId: taskId,
        customerId,
        companyName: customer.companyName,
        currentStage: 'follow_up_1',
        nextRunAt: new Date(Date.now() + Math.max(firstDay, 0) * 24 * 3_600_000 + 3 * 3_600_000).toISOString(),
        status: firstDay === 0 ? 'ready' : 'scheduled',
        strategyId: strategy.strategyId,
        strategyName: strategy.name,
      })
      created.push({ customerId, followUpTaskId: taskId })
    }
    return ok({ created, skipped })
  }),
]
