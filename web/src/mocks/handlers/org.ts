import { http, delay } from 'msw'

import { ErrorCode } from '@/api/error-codes'
import type { Member, OrgProfile } from '@/api/types/org'

import { mockMembers, mockOnboarding, mockOrg, nextId } from '../data/db'
import { LATENCY, fail, ok, readJson } from '../utils'

/** MSW delay：统一模拟网络延迟 */
const sleep = (ms = LATENCY) => delay(ms)

/** GET /org/onboarding —— 初始化向导状态（16 接口文档 §1.2） */
function onboardingHandler() {
  return ok({
    currentStep: mockOnboarding.currentStep,
    steps: [
      { key: 'company', done: mockOnboarding.currentStep > 1 },
      { key: 'products', done: mockOnboarding.currentStep > 2 },
      { key: 'mailbox', done: mockOnboarding.currentStep > 3 },
      { key: 'done', done: mockOnboarding.currentStep >= 4 },
    ],
  })
}

export const orgHandlers = [
  http.get('/api/v1/org/onboarding', async () => {
    await sleep()
    return onboardingHandler()
  }),

  http.put('/api/v1/org/onboarding', async ({ request }) => {
    await sleep()
    const body = await readJson<{ currentStep: number }>(request)
    const step = Number(body.currentStep)
    if (!Number.isInteger(step) || step < 1 || step > 4) {
      return fail(ErrorCode.BAD_REQUEST, 'currentStep 取值 1-4')
    }
    mockOnboarding.currentStep = step
    return onboardingHandler()
  }),

  http.get('/api/v1/org', async () => {
    await sleep()
    return ok(mockOrg)
  }),

  http.put('/api/v1/org', async ({ request }) => {
    await sleep()
    const body = await readJson<Partial<OrgProfile>>(request)
    if (body.name !== undefined && !body.name.trim()) {
      return fail(ErrorCode.BAD_REQUEST, '企业名称不能为空')
    }
    if (body.sendRules) {
      const { timeWindowStart, timeWindowEnd, minTouchIntervalDays } = body.sendRules
      if (
        !timeWindowStart ||
        !timeWindowEnd ||
        timeWindowStart >= timeWindowEnd ||
        (minTouchIntervalDays ?? 0) < 1
      ) {
        return fail(ErrorCode.BAD_REQUEST, '外发规则不合法：窗口起点需早于终点，频控 ≥ 1 天')
      }
    }
    Object.assign(mockOrg, body)
    return ok(mockOrg)
  }),

  http.get('/api/v1/org/members', async () => {
    await sleep()
    return ok(mockMembers)
  }),

  http.post('/api/v1/org/members/invite', async ({ request }) => {
    await sleep()
    const body = await readJson<{ email?: string; role?: Member['role'] }>(request)
    if (!body.email || !body.role) {
      return fail(ErrorCode.BAD_REQUEST, '邮箱与角色必填')
    }
    if (mockMembers.some((m) => m.email === body.email)) {
      return fail(ErrorCode.CONFLICT, '该邮箱已在团队中')
    }
    const member: Member = {
      memberId: nextId('m'),
      name: body.email.split('@')[0] ?? body.email,
      email: body.email,
      role: body.role,
      status: 'invited',
      invitedAt: new Date().toISOString(),
    }
    mockMembers.push(member)
    return ok(member)
  }),

  http.put('/api/v1/org/members/:id', async ({ request, params }) => {
    await sleep()
    const member = mockMembers.find((m) => m.memberId === params.id)
    if (!member) return fail(ErrorCode.NOT_FOUND, '成员不存在')
    const body = await readJson<{ role?: Member['role']; status?: 'active' | 'disabled' }>(request)
    // 防呆：不可停用/降级最后一个管理员（16 FR-03 交互边界）
    const admins = mockMembers.filter((m) => m.role === 'admin' && m.status === 'active')
    if (
      member.role === 'admin' &&
      ((body.role && body.role !== 'admin') || body.status === 'disabled') &&
      admins.length === 1
    ) {
      return fail(ErrorCode.BIZ_VALIDATION, '至少保留一名可用管理员')
    }
    if (body.role) member.role = body.role
    if (body.status) member.status = body.status
    return ok(member)
  }),
]
