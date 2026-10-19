import type { Role } from '@/api/types/common'
import type {
  AiModel,
  AiModelCatalog,
  AiModelVerifyResult,
  ApiKey,
  ApiKeyCreated,
  CrmIntegration,
  CreateAiModelReq,
  CreateApiKeyReq,
  CreateCrmIntegrationReq,
  CreateMailboxReq,
  CreateWebhookReq,
  Mailbox,
  MailboxTestResult,
  NotificationSettings,
  PricingRules,
  RolePermissions,
  SelectAiModelReq,
  UpdateAiModelReq,
  UpdateCrmIntegrationReq,
  UpdatePricingRulesReq,
  VerifyAiModelReq,
  Webhook,
} from '@/api/types/settings'

import { request } from '../http'

// ===== 邮箱连接（16 接口文档 §2：GET/POST/PUT/DELETE /settings/mailboxes）=====

export function fetchMailboxes() {
  return request<Mailbox[]>({ url: '/settings/mailboxes', method: 'GET' })
}

export function createMailbox(data: CreateMailboxReq) {
  return request<Mailbox>({ url: '/settings/mailboxes', method: 'POST', data })
}

export function deleteMailbox(mailboxId: string) {
  return request<null>({ url: `/settings/mailboxes/${mailboxId}`, method: 'DELETE' })
}

/** 连接测试（16 接口文档 §3.4：IMAP/SMTP 分别校验并回显结果） */
export function testMailbox(mailboxId: string) {
  return request<MailboxTestResult>({
    url: `/settings/mailboxes/${mailboxId}/test`,
    method: 'POST',
  })
}

// ===== 权限管理（16 接口文档 §2：GET/PUT /settings/roles/{role}/permissions）=====

export function fetchRolePermissions(role: Role) {
  return request<RolePermissions>({ url: `/settings/roles/${role}/permissions`, method: 'GET' })
}

export function updateRolePermissions(role: Role, data: RolePermissions) {
  return request<RolePermissions>({
    url: `/settings/roles/${role}/permissions`,
    method: 'PUT',
    data,
  })
}

// ===== 通知设置（16 接口文档 §2：GET/PUT /settings/notifications）=====

export function fetchNotificationSettings() {
  return request<NotificationSettings>({ url: '/settings/notifications', method: 'GET' })
}

export function updateNotificationSettings(data: NotificationSettings) {
  return request<NotificationSettings>({ url: '/settings/notifications', method: 'PUT', data })
}

// ===== AI 模型配置（16 FR-10 扩展：GET/POST/PUT/DELETE /settings/ai-models/catalog）=====

/** 模型台账（llm / embedding 两类）+ 各类型当前选用 */
export function fetchAiModels() {
  return request<AiModelCatalog>({ url: '/settings/ai-models/catalog', method: 'GET' })
}

export function createAiModel(data: CreateAiModelReq) {
  return request<AiModel>({ url: '/settings/ai-models/catalog', method: 'POST', data })
}

/** 保存前连通性验证（不落库）：返回 ok=false 时前端阻断保存 */
export function verifyAiModel(data: VerifyAiModelReq) {
  return request<AiModelVerifyResult>({
    url: '/settings/ai-models/catalog/verify',
    method: 'POST',
    data,
  })
}

export function updateAiModel(id: string, data: UpdateAiModelReq) {
  return request<AiModel>({ url: `/settings/ai-models/catalog/${id}`, method: 'PUT', data })
}

export function deleteAiModel(id: string) {
  return request<null>({ url: `/settings/ai-models/catalog/${id}`, method: 'DELETE' })
}

/** 设置某类型（llm / embedding）的全局选用模型 */
export function selectAiModel(data: SelectAiModelReq) {
  return request<AiModelCatalog>({
    url: '/settings/ai-models/catalog/selection',
    method: 'PUT',
    data,
  })
}

// ===== 产品与报价规则（16 §1.6/§3.5 FR-07：GET/PUT /settings/pricing-rules）=====

export function fetchPricingRules() {
  return request<PricingRules>({ url: '/settings/pricing-rules', method: 'GET' })
}

export function updatePricingRules(data: UpdatePricingRulesReq) {
  return request<PricingRules>({ url: '/settings/pricing-rules', method: 'PUT', data })
}

// ===== CRM 集成（16 FR-06 / ER 01 §2.5：GET/POST/PUT/DELETE /settings/integrations）=====

export function fetchCrmIntegrations() {
  return request<CrmIntegration[]>({ url: '/settings/integrations', method: 'GET' })
}

/** 授权连接：同一供应商每组织至多一条（重复提交 → 40901） */
export function createCrmIntegration(data: CreateCrmIntegrationReq) {
  return request<CrmIntegration>({ url: '/settings/integrations', method: 'POST', data })
}

/** 更新同步方向 / 字段映射 / 连接状态（供应商不可改） */
export function updateCrmIntegration(id: string, data: UpdateCrmIntegrationReq) {
  return request<CrmIntegration>({ url: `/settings/integrations/${id}`, method: 'PUT', data })
}

/** 断开连接：删除集成配置（不回溯已同步数据） */
export function deleteCrmIntegration(id: string) {
  return request<{ id: string }>({ url: `/settings/integrations/${id}`, method: 'DELETE' })
}

// ===== 开放 API Key（16 FR-11 / 06 §5.1：GET/POST/DELETE /settings/api-keys）=====

export function fetchApiKeys() {
  return request<ApiKey[]>({ url: '/settings/api-keys', method: 'GET' })
}

/** 创建 API Key：响应携带明文密钥，仅本次返回一次（16 FR-11） */
export function createApiKey(data: CreateApiKeyReq) {
  return request<ApiKeyCreated>({ url: '/settings/api-keys', method: 'POST', data })
}

/** 撤销 API Key：即时失效、不可恢复 */
export function revokeApiKey(keyId: string) {
  return request<{ id: string; status: string }>({
    url: `/settings/api-keys/${keyId}`,
    method: 'DELETE',
  })
}

// ===== 出站 Webhook 订阅（16 FR-11 / 06 §5.2：GET/POST/DELETE /settings/webhooks）=====

export function fetchWebhooks() {
  return request<Webhook[]>({ url: '/settings/webhooks', method: 'GET' })
}

export function createWebhook(data: CreateWebhookReq) {
  return request<Webhook>({ url: '/settings/webhooks', method: 'POST', data })
}

export function deleteWebhook(webhookId: string) {
  return request<{ id: string }>({ url: `/settings/webhooks/${webhookId}`, method: 'DELETE' })
}
