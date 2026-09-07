import type {
  AddToCrmReq,
  AddToCrmResp,
  CreateLeadTaskReq,
  LeadConvertResp,
  LeadHunterSummary,
  LeadItem,
  LeadListReq,
  LeadParseResp,
  LeadSummaryResp,
  LeadTaskCreatedResp,
} from '@/api/types/leads'
import type { PageResp } from '@/api/types/common'

import { request } from '../http'

/** GET /lead-hunter/summary：工作台头部（03 §1.1） */
export function getLeadHunterSummary() {
  return request<LeadHunterSummary>({ url: '/lead-hunter/summary', method: 'GET' })
}

/** POST /lead-tasks/parse：AI 解析/优化目标文本（03 §3.1） */
export function parseLeadGoal(goalText: string) {
  return request<LeadParseResp>({
    url: '/lead-tasks/parse',
    method: 'POST',
    data: { goalText },
  })
}

/** POST /lead-tasks：创建获客任务（03 §3.2） */
export function createLeadTask(data: CreateLeadTaskReq) {
  return request<LeadTaskCreatedResp>({ url: '/lead-tasks', method: 'POST', data })
}

/** GET /leads：发现列表（03 §3.3，筛选/分页） */
export function getLeads(params: LeadListReq) {
  return request<PageResp<LeadItem>>({ url: '/leads', method: 'GET', params })
}

/** GET /leads/summary：各价值档数量（03 §1.6 Tab 计数） */
export function getLeadsSummary() {
  return request<LeadSummaryResp>({ url: '/leads/summary', method: 'GET' })
}

/** POST /leads/add-to-crm：单个/批量加入 CRM（03 §3.4） */
export function addLeadsToCrm(data: AddToCrmReq) {
  return request<AddToCrmResp>({ url: '/leads/add-to-crm', method: 'POST', data })
}

/** POST /leads/{id}/convert：单条加入 CRM（04 §2：lead 预览态顶部动作） */
export function convertLead(leadId: string) {
  return request<LeadConvertResp>({ url: `/leads/${leadId}/convert`, method: 'POST' })
}
