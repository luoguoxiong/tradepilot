import type { Member, OrgProfile } from '@/api/types/org'
import type { Mailbox, RolePermissions } from '@/api/types/settings'

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

/** 12 §3.1 待审数（P0 实际审批来源 = email_send + customer_delete） */
export const mockApprovalTabs = [
  { type: 'all', count: 3 },
  { type: 'email_send', count: 2 },
  { type: 'customer_delete', count: 1 },
]

let seq = 100
export function nextId(prefix: string): string {
  seq += 1
  return `${prefix}-${seq}`
}
