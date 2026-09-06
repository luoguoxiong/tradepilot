import { request } from '@/api/http'
import type { AuthSession, LoginReq, RegisterReq } from '@/api/types/auth'

export function login(req: LoginReq) {
  return request<AuthSession>({ url: '/auth/login', method: 'post', data: req })
}

export function register(req: RegisterReq) {
  return request<AuthSession>({ url: '/auth/register', method: 'post', data: req })
}

export function logout() {
  return request<null>({ url: '/auth/logout', method: 'post' })
}
