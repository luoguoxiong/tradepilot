/**
 * 契约测试基座（真实后端 · 06 §5.3）：
 * - 直连真实 API（默认 http://localhost:3000/api/v1，可用 CONTRACT_API_BASE 覆盖）；
 *   运行前需先启动后端与依赖（PG/Redis：pnpm --filter @tradepilot/api dev）；
 * - 通过 POST /auth/register 建立独立 org 并注入 Bearer token（注册事务内含基线种子）；
 * - 断言统一 envelope（code/message/data）与分页结构（items/total/page/pageSize）。
 */
import { expect } from 'vitest'

import type { ApiResponse, PageResp } from '@/api/types/common'

/** 真实后端基址：默认 API_PORT=3000，可用 CONTRACT_API_BASE 覆盖 */
export const BASE = process.env.CONTRACT_API_BASE ?? 'http://localhost:3000/api/v1'

/** 进程内唯一后缀，规避 org 内唯一约束（公司名 / 联系人邮箱） */
export function uniq(prefix = 'ct'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

let token: string | null = null

export interface RegisteredOrg {
  token: string
  userId: string
  orgId: string
  role: string
  email: string
}

/** 注册全新 org + admin，返回可用凭证（register 事务内含默认策略等基线种子） */
export async function registerOrg(): Promise<RegisteredOrg> {
  const email = `${uniq('contract')}@example.com`
  const { json } = await api<{
    token: string
    user: { userId: string; orgId: string; role: string }
  }>(
    '/auth/register',
    {
      method: 'POST',
      body: JSON.stringify({
        companyName: `Contract Co ${uniq()}`,
        contactName: 'Contract Admin',
        email,
        password: 'Passw0rd123',
      }),
    },
    { auth: false },
  )
  const data = expectOk(json)
  token = data.token
  return {
    token: data.token,
    userId: data.user.userId,
    orgId: data.user.orgId,
    role: data.user.role,
    email,
  }
}

/** 发起契约请求并解析统一 envelope（接口规范 §2.2：HTTP 200 + 业务码） */
export async function api<T>(path: string, init?: RequestInit, opts?: { auth?: boolean }) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts?.auth !== false && token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...headers, ...((init?.headers as Record<string, string> | undefined) ?? {}) },
  })
  const text = await res.text()
  const json = (text ? JSON.parse(text) : { code: 0, message: 'ok', data: null }) as ApiResponse<T>
  return { res, json }
}

/** 断言成功 envelope（code=0 / message=ok） */
export function expectOk<T>(json: ApiResponse<T>): T {
  expect(json.code).toBe(0)
  expect(json.message).toBe('ok')
  return json.data
}

/** 断言业务错误 envelope（错误码 + 非空 message；data 视错误类型可为 null 或字段级 issues） */
export function expectFail<T>(json: ApiResponse<T>, code: number) {
  expect(json.code).toBe(code)
  expect(typeof json.message).toBe('string')
  expect(json.message.length).toBeGreaterThan(0)
}

/** 断言分页结构（接口规范 §2.3：items/total/page/pageSize） */
export function expectPage<T>(data: unknown, opts?: { page?: number; pageSize?: number }) {
  const p = data as PageResp<T>
  expect(Array.isArray(p.items)).toBe(true)
  expect(typeof p.total).toBe('number')
  expect(p.page).toBe(opts?.page ?? 1)
  expect(p.pageSize).toBe(opts?.pageSize ?? 20)
  return p
}
