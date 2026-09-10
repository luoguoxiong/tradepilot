/**
 * 契约测试基座（06 §5.3「mock 即契约」）：
 * - msw/node 直接挂载真实 handler（src/mocks/handlers），请求走 HTTP 层；
 * - handler 以接口文档 schema 为源，契约漂移（envelope/分页/错误码/字段缺失）即测试红；
 * - LATENCY 置 0 消除模拟网络延迟；相对路径 handler 对任意 origin 生效。
 */
import { setupServer } from 'msw/node'
import { expect } from 'vitest'

import { approvalHandlers } from '@/mocks/handlers/approvals'
import { conversationHandlers } from '@/mocks/handlers/conversations'
import { customer360Handlers } from '@/mocks/handlers/customer360'
import { customerHandlers } from '@/mocks/handlers/customers'
import { dashboardHandlers } from '@/mocks/handlers/dashboard'
import { followUpHandlers } from '@/mocks/handlers/follow-ups'
import { knowledgeHandlers } from '@/mocks/handlers/knowledge'
import type { ApiResponse, PageResp } from '@/api/types/common'

/** 契约测试请求基址：msw/node 相对路径 handler 以 jsdom 环境默认 URL（localhost:3000）解析 */
export const BASE = 'http://localhost:3000/api/v1'

export const contractServer = setupServer(
  ...dashboardHandlers,
  ...approvalHandlers,
  ...conversationHandlers,
  ...customerHandlers,
  ...customer360Handlers,
  ...followUpHandlers,
  ...knowledgeHandlers,
)

/** 发起契约请求并解析统一 envelope（接口规范 §2.2：HTTP 200 + 业务码） */
export async function api<T>(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  const json = (await res.json()) as ApiResponse<T>
  return { res, json }
}

/** 断言成功 envelope（code=0 / message=ok） */
export function expectOk<T>(json: ApiResponse<T>): T {
  expect(json.code).toBe(0)
  expect(json.message).toBe('ok')
  return json.data
}

/** 断言业务错误 envelope（错误码 + data=null，03 §4 管道契约） */
export function expectFail<T>(json: ApiResponse<T>, code: number) {
  expect(json.code).toBe(code)
  expect(json.data).toBeNull()
  expect(typeof json.message).toBe('string')
  expect(json.message.length).toBeGreaterThan(0)
}

/** 断言分页结构（接口规范 §2.3：list/total/page/pageSize） */
export function expectPage<T>(data: unknown, opts?: { page?: number; pageSize?: number }) {
  const p = data as PageResp<T>
  expect(Array.isArray(p.items)).toBe(true)
  expect(typeof p.total).toBe('number')
  expect(p.page).toBe(opts?.page ?? 1)
  expect(p.pageSize).toBe(opts?.pageSize ?? 20)
  return p
}
