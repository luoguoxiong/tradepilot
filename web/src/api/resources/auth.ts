import { request } from '@/api/http'
import type { CurrentUser, LoginReq, LoginResp, RegisterReq, RegisterResp } from '@/api/types/auth'

/** 登录（16 接口文档 §3.2）：仅返回 token + 可选向导进度 */
export function login(req: LoginReq) {
  return request<LoginResp>({ url: '/auth/login', method: 'post', data: req })
}

/** 注册企业（16 接口文档 §3.1）：仅返回 token + 基础 user */
export function register(req: RegisterReq) {
  return request<RegisterResp>({ url: '/auth/register', method: 'post', data: req })
}

/** 当前用户与权限（16 接口文档 §2 GET /auth/me）：登录/注册后补拉完整资料 */
export function me() {
  return request<CurrentUser>({ url: '/auth/me', method: 'get' })
}

export function logout() {
  return request<null>({ url: '/auth/logout', method: 'post' })
}
