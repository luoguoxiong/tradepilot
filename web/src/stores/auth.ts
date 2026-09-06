import { defineStore } from 'pinia'

import * as authApi from '@/api/resources/auth'
import type {
  AuthSession,
  LoginReq,
  OrgInfo,
  OnboardingInfo,
  RegisterReq,
  SessionUser,
} from '@/api/types/auth'
import { queryClient } from '@/query/client'

const TOKEN_KEY = 'tradepilot.token'
const SESSION_KEY = 'tradepilot.session'

interface AuthState {
  token: string | null
  user: SessionUser | null
  org: OrgInfo | null
  onboarding: OnboardingInfo | null
}

function readPersisted(): AuthState {
  const token = localStorage.getItem(TOKEN_KEY)
  const raw = localStorage.getItem(SESSION_KEY)
  if (!token || !raw) return { token: null, user: null, org: null, onboarding: null }
  try {
    const session = JSON.parse(raw) as Omit<AuthState, 'token'>
    return { token, ...session }
  } catch {
    return { token: null, user: null, org: null, onboarding: null }
  }
}

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => readPersisted(),

  getters: {
    isLoggedIn: (state) => Boolean(state.token),
    /** 初始化守卫依赖：currentStep < 4 强制走 /onboarding（02 §3） */
    needsOnboarding: (state) => Boolean(state.token) && (state.onboarding?.currentStep ?? 0) < 4,
  },

  actions: {
    async login(req: LoginReq) {
      const session = await authApi.login(req)
      this.applySession(session)
    },

    async register(req: RegisterReq) {
      const session = await authApi.register(req)
      this.applySession(session)
    },

    /** 登出 / 40101 全量清理：token、会话、vue-query 缓存（05 §4.2） */
    async logout() {
      try {
        await authApi.logout()
      } catch {
        // 登出接口失败不阻塞本地清理
      }
      this.clearSession()
      window.location.assign('/login')
    },

    /** 40101 时调用：仅本地清理 + 回登录页（不调用登出接口） */
    forceLogout() {
      if (!this.token) return
      this.clearSession()
      window.location.assign('/login')
    },

    applySession(session: AuthSession) {
      this.token = session.token
      this.user = session.user
      this.org = session.org
      this.onboarding = session.onboarding
      localStorage.setItem(TOKEN_KEY, session.token)
      localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ user: session.user, org: session.org, onboarding: session.onboarding }),
      )
    },

    /** 向导步骤推进后同步持久化（刷新后断点续走，16 v0.4 currentStep 语义） */
    setOnboarding(currentStep: number) {
      this.onboarding = { currentStep }
      if (this.token) {
        localStorage.setItem(
          SESSION_KEY,
          JSON.stringify({ user: this.user, org: this.org, onboarding: this.onboarding }),
        )
      }
    },

    clearSession() {
      this.token = null
      this.user = null
      this.org = null
      this.onboarding = null
      localStorage.removeItem(TOKEN_KEY)
      localStorage.removeItem(SESSION_KEY)
      queryClient.clear()
    },
  },
})
