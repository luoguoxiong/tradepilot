import { http, delay } from 'msw'

import { ErrorCode } from '@/api/error-codes'
import type {
  AiModel,
  AiModelCatalog,
  AiModelVerifyResult,
  CreateAiModelReq,
  CreateMailboxReq,
  Mailbox,
  MailboxTestResult,
  NotificationSettings,
  RolePermissions,
  SelectAiModelReq,
  UpdateAiModelReq,
  VerifyAiModelReq,
} from '@/api/types/settings'
import { KNOWLEDGE_EMBEDDING_DIMENSIONS, MANDATORY_APPROVAL_TYPES } from '@/api/types/settings'
import type { Role } from '@/api/types/common'

import {
  mockAiModels,
  mockMailboxes,
  mockNotificationSettings,
  mockRolePermissions,
  nextId,
} from '../data/db'
import { LATENCY, fail, ok, readJson } from '../utils'

/** 响应剥除明文凭据（16 接口文档 §3.3：永不回显） */
function sanitize(mailbox: Mailbox): Mailbox {
  return {
    ...mailbox,
    imap: mailbox.imap ? { ...mailbox.imap } : undefined,
    smtp: mailbox.smtp ? { ...mailbox.smtp } : undefined,
  }
}

/** 组装 AI 模型台账响应（含各类型选中项），副本返回避免外部改动内存态 */
function aiModelCatalog(): AiModelCatalog {
  const selection: AiModelCatalog['selection'] = { llm: null, embedding: null, search: null }
  for (const model of mockAiModels) {
    if (model.isSelected) selection[model.type] = model.id
  }
  return { models: mockAiModels.map((m) => ({ ...m })), selection }
}

/** embedding 可用性校验（与后端 ai-models.service 同口径），返回错误文案或 null */
function validateEmbedding(provider: string, dimensions: number | null): string | null {
  if (provider !== 'mock' && provider !== 'openai') {
    return '向量模型仅支持 mock / openai 提供方'
  }
  if (dimensions === null) return '向量模型需指定向量维度'
  if (dimensions !== KNOWLEDGE_EMBEDDING_DIMENSIONS) {
    return `向量维度需为 ${KNOWLEDGE_EMBEDDING_DIMENSIONS}（与知识索引一致）`
  }
  return null
}

/** search 供应商可用性校验（与后端 assertSearchUsable 同口径），返回错误文案或 null */
function validateSearch(
  provider: string,
  baseUrl: string | null,
  hasApiKey: boolean,
): string | null {
  if (provider !== 'mock' && provider !== 'http') {
    return '搜索供应商仅支持 mock / http 提供方'
  }
  if (provider === 'http' && !baseUrl) return 'http 搜索供应商需配置接口地址'
  if (provider === 'http' && !hasApiKey) return 'http 搜索供应商需配置 API Key'
  return null
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

  // ===== AI 模型配置（16 FR-10 扩展）=====
  http.get('/api/v1/settings/ai-models/catalog', async () => {
    await delay(LATENCY)
    return ok(aiModelCatalog())
  }),

  http.post('/api/v1/settings/ai-models/catalog', async ({ request }) => {
    await delay(LATENCY)
    const body = await readJson<CreateAiModelReq>(request)
    if (!body.type || !body.name || !body.provider) {
      return fail(ErrorCode.BAD_REQUEST, '类型、名称与提供方必填')
    }
    if (body.type === 'search') {
      const invalid = validateSearch(body.provider, body.baseUrl ?? null, Boolean(body.apiKey))
      if (invalid) return fail(ErrorCode.BIZ_VALIDATION, invalid)
    } else {
      if (!body.model) return fail(ErrorCode.BAD_REQUEST, '模型标识必填')
      if (body.type === 'embedding') {
        const invalid = validateEmbedding(body.provider, body.dimensions ?? null)
        if (invalid) return fail(ErrorCode.BIZ_VALIDATION, invalid)
      }
    }
    if (mockAiModels.some((m) => m.type === body.type && m.name === body.name)) {
      return fail(ErrorCode.CONFLICT, '同名模型已存在')
    }
    const now = new Date().toISOString()
    const model: AiModel = {
      id: nextId('aim'),
      type: body.type,
      name: body.name,
      provider: body.provider,
      // search 无「模型标识」，以 provider 名占位（与后端一致）
      model: body.model ?? body.provider,
      baseUrl: body.baseUrl ?? null,
      dimensions: body.type === 'embedding' ? (body.dimensions ?? null) : null,
      temperature: (body.temperature ?? 0.7).toFixed(2),
      maxTokens: body.type === 'llm' ? (body.maxTokens ?? null) : null,
      hasApiKey: Boolean(body.apiKey),
      // 该类型首个模型创建即选中
      isSelected: !mockAiModels.some((m) => m.type === body.type),
      createdAt: now,
      updatedAt: now,
    }
    mockAiModels.push(model)
    return ok({ ...model })
  }),

  // 保存前连通性验证（不落库）：mock provider 直接通过；
  // 名称/端点含 "fail" 或缺少凭据时返回 ok=false，便于演练「验证不通过则不允许保存」的交互
  http.post('/api/v1/settings/ai-models/catalog/verify', async ({ request }) => {
    await delay(LATENCY)
    const body = await readJson<VerifyAiModelReq>(request)
    const target = body.id ? mockAiModels.find((m) => m.id === body.id) : undefined
    const provider = body.provider ?? target?.provider
    const baseUrl = body.baseUrl !== undefined ? body.baseUrl : (target?.baseUrl ?? null)
    const hasApiKey = Boolean(body.apiKey) || Boolean(target?.hasApiKey)

    let result: AiModelVerifyResult
    if (provider !== 'mock' && !hasApiKey) {
      result = { ok: false, message: '缺少 API Key，无法验证连通性', latencyMs: 0 }
    } else if (/fail/i.test(`${target?.name ?? ''} ${baseUrl ?? ''}`)) {
      result = { ok: false, message: '连接失败：凭据无效或端点不可达', latencyMs: 300 }
    } else {
      result = { ok: true, latencyMs: 300 }
    }
    return ok(result)
  }),

  // 静态段 selection 需先于 :id 注册，避免被动态参数吞掉
  http.put('/api/v1/settings/ai-models/catalog/selection', async ({ request }) => {
    await delay(LATENCY)
    const body = await readJson<SelectAiModelReq>(request)
    if (!body.type) return fail(ErrorCode.BAD_REQUEST, 'type 必填')
    if (body.modelId !== null) {
      const target = mockAiModels.find((m) => m.id === body.modelId)
      if (!target) return fail(ErrorCode.NOT_FOUND, '模型不存在')
      if (target.type !== body.type) return fail(ErrorCode.BIZ_VALIDATION, '模型类型不匹配')
    }
    for (const model of mockAiModels) {
      if (model.type === body.type) model.isSelected = model.id === body.modelId
    }
    return ok(aiModelCatalog())
  }),

  http.put('/api/v1/settings/ai-models/catalog/:id', async ({ request, params }) => {
    await delay(LATENCY)
    const model = mockAiModels.find((m) => m.id === params.id)
    if (!model) return fail(ErrorCode.NOT_FOUND, '模型不存在')
    const body = await readJson<UpdateAiModelReq>(request)
    if (
      body.name &&
      body.name !== model.name &&
      mockAiModels.some((m) => m.type === model.type && m.name === body.name)
    ) {
      return fail(ErrorCode.CONFLICT, '同名模型已存在')
    }
    if (model.type === 'search') {
      // 合并后校验：与后端口径一致（baseUrl 显式 null = 清除端点）
      const invalid = validateSearch(
        body.provider ?? model.provider,
        body.baseUrl !== undefined ? body.baseUrl : model.baseUrl,
        body.apiKey !== undefined || model.hasApiKey,
      )
      if (invalid) return fail(ErrorCode.BIZ_VALIDATION, invalid)
    } else if (model.type === 'embedding') {
      // 合并后校验：与后端口径一致
      const invalid = validateEmbedding(
        body.provider ?? model.provider,
        body.dimensions ?? model.dimensions,
      )
      if (invalid) return fail(ErrorCode.BIZ_VALIDATION, invalid)
    }
    if (body.name !== undefined) model.name = body.name
    if (body.provider !== undefined) model.provider = body.provider
    if (body.model !== undefined) model.model = body.model
    if (body.baseUrl !== undefined) model.baseUrl = body.baseUrl
    if (body.apiKey !== undefined) model.hasApiKey = true
    if (body.dimensions !== undefined) model.dimensions = body.dimensions
    if (body.temperature !== undefined) model.temperature = body.temperature.toFixed(2)
    if (body.maxTokens !== undefined) model.maxTokens = body.maxTokens
    model.updatedAt = new Date().toISOString()
    return ok({ ...model })
  }),

  http.delete('/api/v1/settings/ai-models/catalog/:id', async ({ params }) => {
    await delay(LATENCY)
    const index = mockAiModels.findIndex((m) => m.id === params.id)
    if (index === -1) return fail(ErrorCode.NOT_FOUND, '模型不存在')
    const removed = mockAiModels[index]
    mockAiModels.splice(index, 1)
    // 删除生效模型 → 回退该类型首个剩余模型
    if (removed?.isSelected) {
      const fallback = mockAiModels.find((m) => m.type === removed.type)
      if (fallback) fallback.isSelected = true
    }
    return ok(null)
  }),
]
