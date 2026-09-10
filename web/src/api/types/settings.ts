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

/** AI 模型类型（16 FR-10 扩展）：普通大模型 / 向量化模型 */
export type AiModelType = 'llm' | 'embedding'

/** 模型提供方（与后端 LlmProvider / EmbeddingOptions 对齐） */
export type AiModelProvider = 'mock' | 'openai' | 'anthropic' | 'deepseek' | 'azure'

/** 各模型类型可选的提供方（embedding 目前仅 mock/openai） */
export const AI_MODEL_PROVIDERS: Record<AiModelType, readonly AiModelProvider[]> = {
  llm: ['openai', 'anthropic', 'deepseek', 'azure', 'mock'],
  embedding: ['openai', 'mock'],
}

/**
 * 知识索引向量维度硬约束：`knowledge_chunk.embedding` 为 `vector(1536)`（ER 06），
 * 选用模型维度必须一致，否则入库报维度不匹配 —— 后端同值校验，表单固定不可改。
 */
export const KNOWLEDGE_EMBEDDING_DIMENSIONS = 1536

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
  selection: { llm: string | null; embedding: string | null }
}

export interface CreateAiModelReq {
  type: AiModelType
  name: string
  provider: AiModelProvider
  model: string
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
