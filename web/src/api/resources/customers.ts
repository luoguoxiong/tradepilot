/** 05 CRM 客户中心 + 04 客户 360° API（05 §2 / 04 §2 接口清单） */
import type { PageReq, PageResp } from '@/api/types/common'
import type {
  ActivityItem,
  ActivityListReq,
  BatchDeleteReq,
  BatchDeleteResp,
  BatchOwnerReq,
  BatchOwnerResp,
  ContactItem,
  ContactListReq,
  ConversationItem,
  Customer360Insight,
  Customer360Profile,
  CustomerAnalyzeReq,
  CustomerAnalyzeResp,
  CustomerDeleteResp,
  CustomerDetail,
  CustomerItem,
  CustomerListReq,
  CustomerPayload,
  CustomerProductItem,
  GenerateOutreachResp,
  StageChangeReq,
  StageChangeResp,
} from '@/api/types/customers'

import { request } from '../http'

/** GET /customers：客户列表（tab 区分潜在/正式，05 §3.1） */
export function getCustomers(params: CustomerListReq) {
  return request<PageResp<CustomerItem>>({ url: '/customers', method: 'GET', params })
}

/** GET /customers/{id}：客户详情（复用 04；编辑表单预填） */
export function getCustomer(customerId: string) {
  return request<CustomerDetail>({ url: `/customers/${customerId}`, method: 'GET' })
}

/** POST /customers：添加客户（手工录入，05 §1.2） */
export function createCustomer(data: CustomerPayload) {
  return request<CustomerDetail>({ url: '/customers', method: 'POST', data })
}

/** PUT /customers/{id}：编辑客户资料（改 ownerId 即转交，经理/管理员限定，05 §4） */
export function updateCustomer(customerId: string, data: Partial<CustomerPayload>) {
  return request<CustomerDetail>({ url: `/customers/${customerId}`, method: 'PUT', data })
}

/** POST /customers/{id}/stage：推进客户阶段（非法流转 40901，05 §3.2） */
export function advanceCustomerStage(customerId: string, data: StageChangeReq) {
  return request<StageChangeResp>({ url: `/customers/${customerId}/stage`, method: 'POST', data })
}

/** DELETE /customers/{id}：删除客户 → 生成 customer_delete 审批（05 §3.3） */
export function deleteCustomer(customerId: string) {
  return request<CustomerDeleteResp>({ url: `/customers/${customerId}`, method: 'DELETE' })
}

/** POST /customers/batch-delete：批量删除（逐客户生成审批，05 §3.5） */
export function batchDeleteCustomers(data: BatchDeleteReq) {
  return request<BatchDeleteResp>({ url: '/customers/batch-delete', method: 'POST', data })
}

/** POST /customers/batch-owner：批量改派负责人（仅经理/管理员，05 §3.5） */
export function batchReassignOwners(data: BatchOwnerReq) {
  return request<BatchOwnerResp>({ url: '/customers/batch-owner', method: 'POST', data })
}

/** GET /contacts：联系人列表（05 §2） */
export function getContacts(params: ContactListReq) {
  return request<PageResp<ContactItem>>({ url: '/contacts', method: 'GET', params })
}

/** DELETE /contacts/{id}：删除联系人（单条，普通写操作，05 §3.5） */
export function deleteContact(contactId: string) {
  return request<{ contactId: string }>({ url: `/contacts/${contactId}`, method: 'DELETE' })
}

/** GET /activities：活动列表（全局时间线，05 §3.4） */
export function getActivities(params: ActivityListReq) {
  return request<PageResp<ActivityItem>>({ url: '/activities', method: 'GET', params })
}

// ===================== 04 客户 360° =====================

/** GET /customers/{id}：客户 360° 头部 + Overview（04 §3.1；双数据源 customer/lead） */
export function getCustomer360(customerId: string) {
  return request<Customer360Profile>({ url: `/customers/${customerId}`, method: 'GET' })
}

/** POST /customers/{id}/analyze：触发 AI 分析（异步任务，04 §3.3） */
export function analyzeCustomer(customerId: string, data: CustomerAnalyzeReq) {
  return request<CustomerAnalyzeResp>({
    url: `/customers/${customerId}/analyze`,
    method: 'POST',
    data,
  })
}

/** GET /customers/{id}/insights：AI 客户洞察（04 §3.2） */
export function getCustomerInsight(customerId: string) {
  return request<Customer360Insight>({ url: `/customers/${customerId}/insights`, method: 'GET' })
}

/** GET /customers/{id}/contacts：客户联系人（04 §1.4，分页） */
export function getCustomerContacts(customerId: string, params: ContactListReq) {
  return request<PageResp<ContactItem>>({
    url: `/customers/${customerId}/contacts`,
    method: 'GET',
    params,
  })
}

/** GET /customers/{id}/products：客户产品匹配列表（04 §1.5，行点击抽屉 D7） */
export function getCustomerProducts(customerId: string) {
  return request<CustomerProductItem[]>({ url: `/customers/${customerId}/products`, method: 'GET' })
}

/** GET /customers/{id}/conversations：往来会话（04 §1.5，复用 06，分页） */
export function getCustomerConversations(customerId: string, params: PageReq) {
  return request<PageResp<ConversationItem>>({
    url: `/customers/${customerId}/conversations`,
    method: 'GET',
    params,
  })
}

/** GET /customers/{id}/activities：客户活动时间线（04 §1.5，同 /activities 口径） */
export function getCustomerActivities(customerId: string, params: ActivityListReq) {
  return request<PageResp<ActivityItem>>({
    url: `/customers/${customerId}/activities`,
    method: 'GET',
    params,
  })
}

/** POST /contacts/{id}/generate-outreach：AI 生成开发信草稿（04 §3.4，产出入 06 草稿区） */
export function generateOutreach(
  contactId: string,
  scenario: 'cold_outreach' | 'quote_followup' = 'cold_outreach',
) {
  return request<GenerateOutreachResp>({
    url: `/contacts/${contactId}/generate-outreach`,
    method: 'POST',
    data: { scenario },
  })
}
