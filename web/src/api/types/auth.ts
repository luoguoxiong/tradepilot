import type { Role } from './common'

/** 外发规则（org.send_rules jsonb：发送窗口 + 频控，07 §7.3） */
export interface SendRules {
  /** 当地发送窗口起点 HH:mm，默认 09:00 */
  timeWindowStart?: string
  /** 当地发送窗口终点 HH:mm，默认 18:00 */
  timeWindowEnd?: string
  /** 最小触达间隔天数（含人工外发），默认 3 */
  minTouchIntervalDays?: number
}

/** 当前会话用户（接口规范 §2.1，租户隔离从 JWT 解出，前端不传 orgId） */
export interface SessionUser {
  userId: string
  orgId: string
  role: Role
  name: string
}

/** 企业信息（16 v0.4：区域与本地化 3 默认值） */
export interface OrgInfo {
  id: string
  name: string
  /** IANA 时区，「今日待执行」统一基准 */
  timezone: string
  defaultCurrency: string
  defaultLanguage: 'zh-CN' | 'en'
  sendRules: SendRules | null
}

/** 企业初始化进度（16 v0.4 四步向导，< 4 强制跳 /onboarding） */
export interface OnboardingInfo {
  currentStep: number
}

export interface LoginReq {
  email: string
  password: string
}

/** 注册企业（16 接口文档 §3.1：{ companyName, contactName, email, password }） */
export interface RegisterReq {
  companyName: string
  contactName: string
  email: string
  password: string
}

/** 登录/注册成功返回：token + 会话 + 企业 + 初始化进度（02 §3 守卫链依赖） */
export interface AuthSession {
  token: string
  user: SessionUser
  org: OrgInfo
  onboarding: OnboardingInfo
}
