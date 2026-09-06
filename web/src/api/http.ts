import axios, { type AxiosError, type AxiosRequestConfig } from 'axios'

import { ErrorCode } from '@/api/error-codes'
import type { ApiResponse } from '@/api/types/common'

/** 40101 未认证回调：由 authStore 注册，避免 http ↔ store 循环依赖 */
let onUnauthorized: (() => void) | null = null

export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler
}

/** 业务错误：携带 code/message/traceId，供调用方按错误码管道处理（03 §4） */
export class ApiError extends Error {
  readonly code: number
  readonly traceId?: string

  constructor(code: number, message: string, traceId?: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.traceId = traceId
  }
}

function requestId(): string {
  return crypto.randomUUID()
}

const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || '/api/v1',
  timeout: 15_000,
})

http.interceptors.request.use((config) => {
  const token = localStorage.getItem('tradepilot.token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  config.headers['Accept-Language'] = localStorage.getItem('tradepilot.locale') || 'zh-CN'
  config.headers['X-Request-Id'] = requestId()
  // 写操作默认携带幂等键，同一次表单提交可显式复用（03 §3）
  if (
    config.method &&
    ['post', 'put', 'patch'].includes(config.method) &&
    !config.headers['Idempotency-Key']
  ) {
    config.headers['Idempotency-Key'] = requestId()
  }
  return config
})

http.interceptors.response.use(
  (response) => response,
  (error: AxiosError<ApiResponse<unknown>>) => {
    const body = error.response?.data
    const code = body?.code ?? ErrorCode.INTERNAL
    const message = body?.message ?? error.message
    const traceId = body?.traceId

    if (code === ErrorCode.UNAUTHORIZED) {
      // 40101 清会话 → 守卫拦截；只触发一次（03 §4）
      onUnauthorized?.()
    }
    return Promise.reject(new ApiError(code, message, traceId))
  },
)

/** 强类型请求：解包 envelope，直接返回 data */
export async function request<T>(config: AxiosRequestConfig): Promise<T> {
  const response = await http.request<ApiResponse<T>>(config)
  const body = response.data
  if (body.code !== ErrorCode.OK) {
    throw new ApiError(body.code, body.message, body.traceId)
  }
  return body.data
}

export { http }
