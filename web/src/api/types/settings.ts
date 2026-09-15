import type { Role } from './common'

export type MailboxProvider = 'gmail' | 'outlook' | 'smtp_imap'
export type MailboxStatus = 'connected' | 'error' | 'disconnected'

/** IMAP/SMTP 连接配置（16 接口文档 §1.5：凭据加密存储，响应永不回显明文） */
export interface MailboxChannel {
  host: string
  port: number
  ssl: boolean
  /** 仅创建/更新请求携带；响应中服务端剥除 */
  credential?: string
}

export interface SyncScope {
  historyDays: number
  folders: string[]
}

export interface Mailbox {
  mailboxId: string
  provider: MailboxProvider
  account: string
  imap?: Omit<MailboxChannel, 'credential'>
  smtp?: Omit<MailboxChannel, 'credential'>
  syncScope: SyncScope
  status: MailboxStatus
}

export interface CreateMailboxReq {
  provider: MailboxProvider
  account: string
  imap?: MailboxChannel
  smtp?: MailboxChannel
  syncScope: SyncScope
}

/** POST /settings/mailboxes/{id}/test 响应（16 接口文档 §3.4） */
export interface MailboxTestResult {
  ok: boolean
  imap?: 'ok' | 'fail'
  smtp?: 'ok' | 'fail'
  error?: string
}

/** 强制审批绑定类型（16 接口文档 §3.6：不可被配置绕过，传 none → 42201） */
export const MANDATORY_APPROVAL_TYPES = [
  'quote',
  'email_send',
  'contract',
  'order_change',
  'bulk_marketing',
  'customer_delete',
] as const

/** medium 类型可开 autoApprove（12 §7.1） */
export const AUTO_APPROVABLE_TYPES = ['email_send', 'order_change', 'bulk_marketing'] as const

export interface ApprovalRule {
  approvalType: string
  approverRoles: Role[]
  autoApprove: boolean
}

/** 角色权限（16 接口文档 §1.7：GET/PUT /settings/roles/{role}/permissions） */
export interface RolePermissions {
  role: Role
  permissions: {
    customers: 'self' | 'team' | 'all'
    quotes: 'view' | 'edit' | 'approve'
    approvals: string[]
    settings: 'manage' | 'view' | 'none'
  }
  approvalRules: ApprovalRule[]
}

/** 通知设置（16 接口文档 §1.8 FR-09）：事件 × 渠道开关 */
export interface NotificationSettings {
  events: Record<
    'approval_pending' | 'risk_alert' | 'task_failed',
    { site: boolean; email: boolean }
  >
}

/** AI 模型类型（16 FR-10 扩展）：普通大模型 / 向量化模型 / 搜索供应商 */
export type AiModelType = 'llm' | 'embedding' | 'search'

/** 模型提供方（与后端 LlmProvider / EmbeddingOptions / SearchOptions 并集对齐） */
export type AiModelProvider = 'mock' | 'openai' | 'anthropic' | 'deepseek' | 'azure' | 'http'

/** 各模型类型可选的提供方（与后端 service 的按 type 白名单同口径） */
export const AI_MODEL_PROVIDERS: Record<AiModelType, readonly AiModelProvider[]> = {
  llm: ['openai', 'anthropic', 'deepseek', 'azure', 'mock'],
  embedding: ['openai', 'mock'],
  search: ['http', 'mock'],
}

/**
 * 知识索引向量维度硬约束：与 `knowledge_chunk.embedding` 的列维度一致
 * （ER 06 原为 vector(1536)；P1 迁移 0005 调整为 vector(2048)：所选模型原生 2048 维且不支持截断），
 * 选用模型维度必须一致，否则入库报维度不匹配 —— 后端同值校验，表单固定不可改。
 */
export const KNOWLEDGE_EMBEDDING_DIMENSIONS = 2048

export interface AiModel {
  id: string
  type: AiModelType
  name: string
  provider: AiModelProvider
  model: string
  baseUrl: string | null
  dimensions: number | null
  temperature: string
  maxTokens: number | null
  /** 是否已配置 apiKey（明文不回显） */
  hasApiKey: boolean
  /** 是否为该类型下当前生效模型 */
  isSelected: boolean
  createdAt: string
  updatedAt: string
}

/** GET /settings/ai-models/catalog 响应 */
export interface AiModelCatalog {
  models: AiModel[]
  selection: { llm: string | null; embedding: string | null; search: string | null }
}

export interface CreateAiModelReq {
  type: AiModelType
  name: string
  provider: AiModelProvider
  /** llm/embedding 必填；search 无模型标识（服务端以 provider 占位） */
  model?: string
  baseUrl?: string
  /** 仅请求携带，服务端加密落库、响应不回显；编辑留空表示不变更 */
  apiKey?: string
  dimensions?: number
  temperature?: number
  maxTokens?: number
}

export type UpdateAiModelReq = Partial<Omit<CreateAiModelReq, 'type' | 'baseUrl'>> & {
  /** 显式 null 清除自定义端点 */
  baseUrl?: string | null
}

export interface SelectAiModelReq {
  type: AiModelType
  modelId: string | null
}

/** POST /settings/ai-models/catalog/verify（保存前连通性验证，不落库） */
export interface VerifyAiModelReq {
  /** 编辑场景提供：未显式传的字段/凭据回退库中现值 */
  id?: string
  type: AiModelType
  provider: AiModelProvider
  model?: string
  /** 显式 null 表示清空自定义端点 */
  baseUrl?: string | null
  apiKey?: string
  dimensions?: number
}

export interface AiModelVerifyResult {
  ok: boolean
  /** ok=false 时的可读原因 */
  message?: string
  latencyMs: number
}

// ===== 产品与报价规则（16 §1.6/§3.5 FR-07；org 单例）=====

/** 成本项白名单（与后端 pricingCostItemKeys / @tradepilot/core COST_ITEM_KEYS 同源） */
export const PRICING_COST_ITEM_KEYS = ['purchase', 'freight', 'insurance', 'tax', 'fx'] as const
export type PricingCostItemKey = (typeof PRICING_COST_ITEM_KEYS)[number]

/** 贸易条款白名单（Incoterms 2020，与后端 incotermsOptions 同源；MVP 默认 FOB） */
export const INCOTERMS_OPTIONS = [
  'EXW',
  'FCA',
  'FAS',
  'FOB',
  'CFR',
  'CIF',
  'CPT',
  'CIP',
  'DAP',
  'DPU',
  'DDP',
] as const
export type Incoterm = (typeof INCOTERMS_OPTIONS)[number]

/** 产品与报价规则（GET/PUT /settings/pricing-rules，接口 16 §1.6/§3.5） */
export interface PricingRules {
  productCategories: string[]
  costItems: PricingCostItemKey[]
  /** 利润红线（%）：报价利润率低于该值 → 服务端 100% 拦截（42201） */
  profitFloorPct: number
  /** 让价梯度（如 [3,2,1]）：每轮一个正整数百分比 */
  discountLadder: number[]
  defaultIncoterms: Incoterm
  /** 默认币种：ISO 4217 三位大写字母 */
  defaultCurrency: string
  /** 汇率源：MVP 固定 manual */
  exchangeRateSource: 'manual'
}
export type UpdatePricingRulesReq = PricingRules

// ===== 开放 API Key（16 FR-11 / 后端技术方案 06 §5.1）=====

export type ApiKeyStatus = 'active' | 'revoked'

/** API Key scope 白名单（与后端 API_SCOPE_LIST 同源） */
export const API_SCOPES = [
  'customers:read',
  'customers:write',
  'tasks:read',
  'tasks:write',
  'quotes:read',
  'quotes:write',
  'orders:read',
  'orders:write',
  'analytics:read',
] as const
export type ApiScope = (typeof API_SCOPES)[number]

/** API Key 列表项（永不回显明文/哈希） */
export interface ApiKey {
  id: string
  name: string
  keyPrefix: string
  scopes: string[]
  status: ApiKeyStatus
  createdBy: string | null
  lastUsedAt: string | null
  createdAt: string
}

/** 创建响应：`key` 为明文密钥，仅本次返回一次 */
export interface ApiKeyCreated extends ApiKey {
  key: string
}

export interface CreateApiKeyReq {
  name: string
  scopes: ApiScope[]
}

// ===== 出站 Webhook 订阅（16 FR-11 / 后端技术方案 06 §5.2）=====

export type WebhookStatus = 'active' | 'disabled'

/** 可订阅事件白名单（与后端 WEBHOOK_EVENT_LIST 同源） */
export const WEBHOOK_EVENTS = [
  'approval_pending',
  'risk_alert',
  'task_failed',
  'task.completed',
  'approval.decided',
  'message.received',
  'customer.created',
] as const
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

/** Webhook 订阅视图（不含 secret / secret_enc） */
export interface Webhook {
  id: string
  url: string
  events: string[]
  status: WebhookStatus
  createdAt: string
  updatedAt: string
}

export interface CreateWebhookReq {
  url: string
  events: WebhookEvent[]
  /** 签名密钥（≥16 位），服务端加密入库、接口永不回显 */
  secret: string
}

// ===== CRM 集成（16 FR-06 / ER 01 §2.5：GET/POST/PUT/DELETE /settings/integrations）=====

/**
 * 供应商白名单（与后端 `crmProviders` 同源）。
 * MVP 仅落地「授权连接 + 字段映射 + 同步方向」配置（后端技术方案 06 §6：不做任何外呼），
 * 实际拉取/推送由后续 CrmDriver 消费本配置。
 */
export const CRM_PROVIDERS = ['xiaoman', 'futong'] as const
export type CrmProvider = (typeof CRM_PROVIDERS)[number]

/** 同步方向（ER 01 §2.5）：pull=外部→本地 / push=本地→外部 / both=双向 */
export const CRM_SYNC_DIRECTIONS = ['pull', 'push', 'both'] as const
export type CrmSyncDirection = (typeof CRM_SYNC_DIRECTIONS)[number]

export type CrmIntegrationStatus = 'connected' | 'disconnected'

/** 可映射的本地字段白名单（与后端 `crmLocalFields` 同源，05 CRM 口径） */
export const CRM_LOCAL_FIELDS = [
  'customer.companyName',
  'customer.country',
  'customer.website',
  'customer.industry',
  'customer.remark',
  'contact.name',
  'contact.title',
  'contact.email',
  'contact.phone',
] as const
export type CrmLocalField = (typeof CRM_LOCAL_FIELDS)[number]

/** 字段映射条目：本地字段 → 外部 CRM 字段名 */
export interface CrmFieldMapping {
  local: CrmLocalField
  remote: string
}

/** CRM 集成视图（接口 16 §1.8；`lastSyncAt` 在外呼驱动接入前恒为 null） */
export interface CrmIntegration {
  id: string
  provider: CrmProvider
  status: CrmIntegrationStatus
  syncDirection: CrmSyncDirection
  mapping: CrmFieldMapping[] | null
  lastSyncAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateCrmIntegrationReq {
  provider: CrmProvider
  syncDirection: CrmSyncDirection
  mapping?: CrmFieldMapping[]
}

export interface UpdateCrmIntegrationReq {
  syncDirection?: CrmSyncDirection
  /** 显式 null = 清空映射 */
  mapping?: CrmFieldMapping[] | null
  status?: CrmIntegrationStatus
}
