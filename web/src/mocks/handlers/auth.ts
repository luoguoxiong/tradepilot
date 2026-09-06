import { http, delay } from 'msw'

import { ErrorCode } from '@/api/error-codes'
import type { AuthSession, LoginReq, RegisterReq } from '@/api/types/auth'

import { LATENCY, fail, ok, readJson } from '../utils'

/** 演示会话：任意合法邮箱 + 8 位以上密码可登录，角色 admin 覆盖 P0 全部入口 */
function sessionFor(currentStep = 4): AuthSession {
  return {
    token: `mock-${crypto.randomUUID()}`,
    user: { userId: 'u-demo', orgId: 'org-demo', role: 'admin', name: '演示管理员' },
    org: {
      id: 'org-demo',
      name: '演示外贸公司',
      timezone: 'Asia/Shanghai',
      defaultCurrency: 'USD',
      defaultLanguage: 'zh-CN',
      sendRules: { timeWindowStart: '09:00', timeWindowEnd: '18:00', minTouchIntervalDays: 3 },
    },
    onboarding: { currentStep },
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const authHandlers = [
  http.post('/api/v1/auth/login', async ({ request }) => {
    await delay(LATENCY)
    const body = await readJson<LoginReq>(request)
    // 统一防枚举提示：不区分「邮箱不存在 / 密码错误」（16 v0.4）
    if (!EMAIL_RE.test(body.email ?? '') || (body.password?.length ?? 0) < 8) {
      return fail(ErrorCode.BAD_REQUEST, '邮箱或密码错误')
    }
    return ok(sessionFor())
  }),

  http.post('/api/v1/auth/register', async ({ request }) => {
    await delay(LATENCY)
    const body = await readJson<RegisterReq>(request)
    if (!body.orgName || !EMAIL_RE.test(body.email ?? '') || (body.password?.length ?? 0) < 8) {
      return fail(ErrorCode.BAD_REQUEST, '注册信息不完整')
    }
    // 注册后进入初始化向导（currentStep = 1，守卫强制跳 /onboarding）
    return ok(sessionFor(1))
  }),

  http.post('/api/v1/auth/logout', async () => {
    await delay(100)
    return ok(null)
  }),
]
