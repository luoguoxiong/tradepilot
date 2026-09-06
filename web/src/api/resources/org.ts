import type {
  InviteMemberReq,
  Member,
  OnboardingStatus,
  OrgProfile,
  UpdateMemberReq,
} from '@/api/types/org'

import { request } from '../http'

/** 初始化向导状态（16 接口文档 §1.2） */
export function fetchOnboarding() {
  return request<OnboardingStatus>({ url: '/org/onboarding', method: 'GET' })
}

/** 推进向导步骤（断点续走：PUT currentStep） */
export function advanceOnboarding(currentStep: number) {
  return request<OnboardingStatus>({
    url: '/org/onboarding',
    method: 'PUT',
    data: { currentStep },
  })
}

/** 企业信息（16 接口文档 §1.3） */
export function fetchOrg() {
  return request<OrgProfile>({ url: '/org', method: 'GET' })
}

export function updateOrg(data: Partial<OrgProfile>) {
  return request<OrgProfile>({ url: '/org', method: 'PUT', data })
}

/** 团队成员（16 接口文档 §1.4） */
export function fetchMembers() {
  return request<Member[]>({ url: '/org/members', method: 'GET' })
}

export function inviteMember(data: InviteMemberReq) {
  return request<Member>({ url: '/org/members/invite', method: 'POST', data })
}

export function updateMember(memberId: string, data: UpdateMemberReq) {
  return request<Member>({ url: `/org/members/${memberId}`, method: 'PUT', data })
}
