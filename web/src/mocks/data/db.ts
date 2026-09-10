import type { Member, OrgProfile } from '@/api/types/org'
import type { AiModel, Mailbox, RolePermissions } from '@/api/types/settings'

/**
 * mock 内存态（06 §5.3）：与接口文档 schema 同构，MSW handler 与单测复用。
 * 会话内可变，刷新页面即重置。
 */

export const mockOrg: OrgProfile = {
  id: 'org-demo',
  name: '演示外贸公司',
  country: '中国',
  industry: '体育用品',
  timezone: 'Asia/Shanghai',
  defaultCurrency: 'USD',
  defaultLanguage: 'zh-CN',
  logo: '',
  sendRules: { timeWindowStart: '09:00', timeWindowEnd: '18:00', minTouchIntervalDays: 3 },
}

export const mockOnboarding = { currentStep: 4 }

export const mockMembers: Member[] = [
  {
    memberId: 'm-1',
    name: '张三',
    email: 'zhang@company.com',
    role: 'admin',
    status: 'active',
    joinedAt: '2026-08-01T02:00:00Z',
  },
  {
    memberId: 'm-2',
    name: '李四',
    email: 'li@company.com',
    role: 'manager',
    status: 'active',
    joinedAt: '2026-08-03T02:00:00Z',
  },
  {
    memberId: 'm-3',
    name: '王五',
    email: 'wang@company.com',
    role: 'sales',
    status: 'invited',
    invitedAt: '2026-09-01T02:00:00Z',
  },
]

export const mockMailboxes: Mailbox[] = [
  {
    mailboxId: 'mb-1',
    provider: 'smtp_imap',
    account: 'sales@company.com',
    imap: { host: 'imap.company.com', port: 993, ssl: true },
    smtp: { host: 'smtp.company.com', port: 465, ssl: true },
    syncScope: { historyDays: 90, folders: ['INBOX', 'Sent'] },
    status: 'connected',
  },
  {
    mailboxId: 'mb-2',
    provider: 'gmail',
    account: 'info@company.com',
    syncScope: { historyDays: 30, folders: ['INBOX'] },
    status: 'disconnected',
  },
  // M5 FR-11 三邮箱聚合演示（conv_4/conv_6 来源）
  {
    mailboxId: 'mb-3',
    provider: 'smtp_imap',
    account: 'support@company.com',
    imap: { host: 'imap.company.com', port: 993, ssl: true },
    smtp: { host: 'smtp.company.com', port: 465, ssl: true },
    syncScope: { historyDays: 60, folders: ['INBOX', 'Sent'] },
    status: 'connected',
  },
]

export const mockRolePermissions: Record<string, RolePermissions> = {
  admin: {
    role: 'admin',
    permissions: {
      customers: 'all',
      quotes: 'approve',
      approvals: [
        'quote',
        'email_send',
        'contract',
        'order_change',
        'bulk_marketing',
        'customer_delete',
      ],
      settings: 'manage',
    },
    approvalRules: [
      { approvalType: 'quote', approverRoles: ['admin', 'manager'], autoApprove: false },
      { approvalType: 'email_send', approverRoles: ['admin', 'manager'], autoApprove: true },
      { approvalType: 'contract', approverRoles: ['admin'], autoApprove: false },
      { approvalType: 'order_change', approverRoles: ['admin', 'manager'], autoApprove: true },
      { approvalType: 'bulk_marketing', approverRoles: ['admin', 'manager'], autoApprove: false },
      { approvalType: 'customer_delete', approverRoles: ['admin'], autoApprove: false },
    ],
  },
  manager: {
    role: 'manager',
    permissions: { customers: 'team', quotes: 'edit', approvals: ['email_send'], settings: 'view' },
    approvalRules: [],
  },
  sales: {
    role: 'sales',
    permissions: { customers: 'self', quotes: 'view', approvals: [], settings: 'none' },
    approvalRules: [],
  },
}

export const mockNotificationSettings = {
  events: {
    approval_pending: { site: true, email: true },
    risk_alert: { site: true, email: true },
    task_failed: { site: true, email: false },
  },
}

/** AI 模型台账（16 FR-10 扩展）：每 type 至多一个 isSelected */
export const mockAiModels: AiModel[] = [
  {
    id: 'aim-1',
    type: 'llm',
    name: 'GPT-4o',
    provider: 'openai',
    model: 'gpt-4o',
    baseUrl: null,
    dimensions: null,
    temperature: '0.70',
    maxTokens: 4096,
    hasApiKey: true,
    isSelected: true,
    createdAt: '2026-08-01T02:00:00Z',
    updatedAt: '2026-08-01T02:00:00Z',
  },
  {
    id: 'aim-2',
    type: 'llm',
    name: 'Claude Sonnet',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    baseUrl: null,
    dimensions: null,
    temperature: '0.30',
    maxTokens: 8192,
    hasApiKey: true,
    isSelected: false,
    createdAt: '2026-08-05T02:00:00Z',
    updatedAt: '2026-08-05T02:00:00Z',
  },
  {
    id: 'aim-3',
    type: 'embedding',
    name: 'Text Embedding 3 Small',
    provider: 'openai',
    model: 'text-embedding-3-small',
    baseUrl: null,
    dimensions: 1536,
    temperature: '0.70',
    maxTokens: null,
    hasApiKey: true,
    isSelected: true,
    createdAt: '2026-08-01T02:00:00Z',
    updatedAt: '2026-08-01T02:00:00Z',
  },
  {
    id: 'aim-4',
    type: 'search',
    name: 'Serper',
    provider: 'http',
    // search 无模型标识，以 provider 占位（与后端一致）
    model: 'http',
    baseUrl: 'https://google.serper.dev',
    dimensions: null,
    temperature: '0.70',
    maxTokens: null,
    hasApiKey: true,
    isSelected: true,
    createdAt: '2026-08-01T02:00:00Z',
    updatedAt: '2026-08-01T02:00:00Z',
  },
]

let seq = 100
export function nextId(prefix: string): string {
  seq += 1
  return `${prefix}-${seq}`
}
