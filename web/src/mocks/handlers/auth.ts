import { delay, http } from 'msw'

import { ErrorCode } from '@/api/error-codes'
import type { LoginReq, RegisterReq } from '@/api/types/auth'

import { mockOnboarding, mockRolePermissions } from '../data/db'
import { LATENCY, fail, ok, readJson } from '../utils'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** mock token：与真实 JWT 仅形状相似（payload 非对称），仅供会话模拟 */
function mockToken() {
  return `mock-${crypto.randomUUID()}`
}

export const authHandlers = [
  http.post('/api/v1/auth/login', async ({ request }) => {
    await delay(LATENCY)
    const body = await readJson<LoginReq>(request)
    // 统一防枚举提示：不区分「邮箱不存在 / 密码错误」（16 v0.4）
    if (!EMAIL_RE.test(body.email ?? '') || (body.password?.length ?? 0) < 8) {
      return fail(ErrorCode.BAD_REQUEST, '邮箱或密码错误')
    }
    // 16 接口文档 §3.2：{ token, expiresIn, onboarding: { currentStep } }（未完成初始化时前端进向导）
    return ok({
      token: mockToken(),
      expiresIn: 7200,
      onboarding: { currentStep: mockOnboarding.currentStep },
    })
  }),

  http.post('/api/v1/auth/register', async ({ request }) => {
    await delay(LATENCY)
    const body = await readJson<RegisterReq>(request)
    // 统一防枚举提示；密码 ≥ 8 位（16 v0.4）
    if (
      !body.companyName ||
      !body.contactName ||
      !EMAIL_RE.test(body.email ?? '') ||
      (body.password?.length ?? 0) < 8
    ) {
      return fail(ErrorCode.BAD_REQUEST, '注册信息不完整')
    }
    // 注册后进入初始化向导（currentStep = 1，守卫强制跳 /onboarding）
    mockOnboarding.currentStep = 1
    // 16 接口文档 §3.1：{ token, user: { userId, orgId, role: "admin" } }
    return ok({
      token: mockToken(),
      expiresIn: 7200,
      user: { userId: 'u-demo', orgId: 'org-demo', role: 'admin' },
    })
  }),

  // GET /auth/me —— 当前用户与权限（16 接口文档 §2）；登录/注册后由 auth store 补拉组装完整会话
  http.get('/api/v1/auth/me', async () => {
    await delay(LATENCY)
    return ok({
      userId: 'u-demo',
      orgId: 'org-demo',
      role: 'admin',
      name: '演示管理员',
      email: 'admin@company.com',
      permissions: mockRolePermissions.admin.permissions,
    })
  }),

  http.post('/api/v1/auth/logout', async () => {
    await delay(100)
    return ok(null)
  }),
]
