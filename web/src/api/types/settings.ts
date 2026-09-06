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
