import type { Role } from '@/api/types/common'
import type {
  CreateMailboxReq,
  Mailbox,
  MailboxTestResult,
  NotificationSettings,
  RolePermissions,
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
