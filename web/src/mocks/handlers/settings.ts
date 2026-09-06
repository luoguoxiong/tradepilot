import { http, delay } from 'msw'

import { ErrorCode } from '@/api/error-codes'
import type {
  CreateMailboxReq,
  Mailbox,
  MailboxTestResult,
  NotificationSettings,
  RolePermissions,
} from '@/api/types/settings'
import { MANDATORY_APPROVAL_TYPES } from '@/api/types/settings'
import type { Role } from '@/api/types/common'

import { mockMailboxes, mockNotificationSettings, mockRolePermissions, nextId } from '../data/db'
import { LATENCY, fail, ok, readJson } from '../utils'

/** 响应剥除明文凭据（16 接口文档 §3.3：永不回显） */
function sanitize(mailbox: Mailbox): Mailbox {
  return {
    ...mailbox,
    imap: mailbox.imap ? { ...mailbox.imap } : undefined,
    smtp: mailbox.smtp ? { ...mailbox.smtp } : undefined,
  }
}

export const settingsHandlers = [
  // ===== 邮箱连接 =====
  http.get('/api/v1/settings/mailboxes', async () => {
    await delay(LATENCY)
    return ok(mockMailboxes.map(sanitize))
  }),

  http.post('/api/v1/settings/mailboxes', async ({ request }) => {
    await delay(LATENCY)
    const body = await readJson<CreateMailboxReq>(request)
    if (!body.account || !body.provider || !body.syncScope) {
      return fail(ErrorCode.BAD_REQUEST, '提供商、邮箱账号与同步范围必填')
    }
    if (!body.imap || !body.smtp) {
      return fail(ErrorCode.BAD_REQUEST, 'IMAP/SMTP 配置不完整')
    }
    if (mockMailboxes.some((m) => m.account === body.account)) {
      return fail(ErrorCode.CONFLICT, '该邮箱已连接')
    }
    const { imap, smtp } = body
    const mailbox: Mailbox = {
      mailboxId: nextId('mb'),
      provider: body.provider,
      account: body.account,
      imap: { host: imap.host, port: imap.port, ssl: imap.ssl },
      smtp: { host: smtp.host, port: smtp.port, ssl: smtp.ssl },
      syncScope: { historyDays: body.syncScope.historyDays, folders: [...body.syncScope.folders] },
      status: 'connected',
    }
    mockMailboxes.unshift(mailbox)
    return ok(sanitize(mailbox))
  }),

  http.delete('/api/v1/settings/mailboxes/:id', async ({ params }) => {
    await delay(LATENCY)
    const index = mockMailboxes.findIndex((m) => m.mailboxId === params.id)
    if (index === -1) return fail(ErrorCode.NOT_FOUND, '邮箱连接不存在')
    mockMailboxes.splice(index, 1)
    return ok(null)
  }),

  http.post('/api/v1/settings/mailboxes/:id/test', async ({ params }) => {
    await delay(800)
    const mailbox = mockMailboxes.find((m) => m.mailboxId === params.id)
    if (!mailbox) return fail(ErrorCode.NOT_FOUND, '邮箱连接不存在')
    // mock 口径：账号含 "fail" 模拟失败，便于演练错误态 UI
    const result: MailboxTestResult = mailbox.account.includes('fail')
      ? { ok: false, imap: 'ok', smtp: 'fail', error: 'SMTP auth failed' }
      : { ok: true, imap: 'ok', smtp: 'ok' }
    mailbox.status = result.ok ? 'connected' : 'error'
    return ok(result)
  }),

  // ===== 权限管理 =====
  http.get('/api/v1/settings/roles/:role/permissions', async ({ params }) => {
    await delay(LATENCY)
    const permissions = mockRolePermissions[params.role as Role]
    return permissions ? ok(permissions) : fail(ErrorCode.NOT_FOUND, '角色不存在')
  }),

  http.put('/api/v1/settings/roles/:role/permissions', async ({ request, params }) => {
    await delay(LATENCY)
    const role = params.role as Role
    const stored = mockRolePermissions[role]
    if (!stored) return fail(ErrorCode.NOT_FOUND, '角色不存在')
    const body = await readJson<RolePermissions>(request)

    // 强制审批绑定不可绕过（16 接口文档 §3.6：approverRoles 为空 → 42201）
    for (const rule of body.approvalRules ?? []) {
      if (
        (MANDATORY_APPROVAL_TYPES as readonly string[]).includes(rule.approvalType) &&
        (!rule.approverRoles || rule.approverRoles.length === 0)
      ) {
        return fail(ErrorCode.BIZ_VALIDATION, `${rule.approvalType} 审批绑定不可置空`)
      }
    }
    stored.permissions = { ...stored.permissions, ...body.permissions }
    stored.approvalRules = body.approvalRules ?? stored.approvalRules
    return ok(stored)
  }),

  // ===== 通知设置 =====
  http.get('/api/v1/settings/notifications', async () => {
    await delay(LATENCY)
    return ok(mockNotificationSettings)
  }),

  http.put('/api/v1/settings/notifications', async ({ request }) => {
    await delay(LATENCY)
    const body = await readJson<NotificationSettings>(request)
    if (!body.events) return fail(ErrorCode.BAD_REQUEST, 'events 必填')
    Object.assign(mockNotificationSettings.events, body.events)
    return ok(mockNotificationSettings)
  }),
]
