import type { OrgInfo } from './auth'

/** 企业完整资料（16 接口文档 §1.3：GET/PUT /org） */
export interface OrgProfile extends OrgInfo {
  country?: string
  industry?: string
  logo?: string
}

/** 初始化向导状态（16 接口文档 §1.2）：{ currentStep: 1-4, steps: [{ key, done }] } */
export interface OnboardingStatus {
  currentStep: number
  steps: { key: 'company' | 'products' | 'mailbox' | 'done'; done: boolean }[]
}

/** 团队成员（16 接口文档 §1.4） */
export interface Member {
  memberId: string
  name: string
  email: string
  role: 'admin' | 'manager' | 'sales'
  status: 'active' | 'disabled' | 'invited'
  invitedAt?: string
  joinedAt?: string
}

export interface InviteMemberReq {
  email: string
  role: 'admin' | 'manager' | 'sales'
}

/** 角色变更 / 停用（PUT /org/members/{id}，字段可选） */
export interface UpdateMemberReq {
  role?: 'admin' | 'manager' | 'sales'
  status?: 'active' | 'disabled'
}
