import { HttpResponse } from 'msw'

import { ErrorCode } from '@/api/error-codes'
import type { ApiResponse, PageResp } from '@/api/types/common'

/** mock 统一延迟，模拟真实网络 */
export const LATENCY = 300

/** 成功 envelope */
export function ok<T>(data: T): HttpResponse<ApiResponse<unknown>> {
  return HttpResponse.json<ApiResponse<T>>({ code: ErrorCode.OK, message: 'ok', data })
}

/** 业务错误 envelope（HTTP 200 + 业务码，契约与 03 §4 管道一致） */
export function fail(code: number, message: string): HttpResponse<ApiResponse<unknown>> {
  return HttpResponse.json<ApiResponse<null>>({ code, message, data: null })
}

/** 分页包装（接口规范 §2.2：{ items, total, page, pageSize }） */
export function page<T>(items: T[], total: number, page = 1, pageSize = 20): PageResp<T> {
  return { items, total, page, pageSize }
}

/** 读取 JSON body（容错空体） */
export async function readJson<B>(request: Request): Promise<Partial<B>> {
  try {
    return (await request.json()) as Partial<B>
  } catch {
    return {}
  }
}
