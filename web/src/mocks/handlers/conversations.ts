import { http, delay } from 'msw'

import { ErrorCode } from '@/api/error-codes'
import type {
  AiDraft,
  ConversationDetail,
  ConversationListItem,
  ConversationMessage,
  CopilotData,
  SendResp,
} from '@/api/types/conversations'

import {
  appendDraftMessage,
  buildAiDraftContent,
  buildAskAiAnswer,
  citationsOf,
  findConversation,
  findMessage,
  lastMessageOf,
  markConversationRead,
  mergeSuggestionsIntoDraft,
  mockConversations,
} from '../data/conversations'
import { registerEmailSendApproval } from '../data/approvals'
import { nextId } from '../data/db'
import { LATENCY, fail, ok, page, readJson } from '../utils'

/** 列表行投影（06 §1.1：9 字段） */
function toListItem(conv: (typeof mockConversations)[number]): ConversationListItem {
  const last = lastMessageOf(conv)
  return {
    conversationId: conv.conversationId,
    contactName: conv.contactName,
    companyName: conv.companyName,
    priority: conv.priority,
    lastMessagePreview: last.content.replace(/\s+/g, ' ').slice(0, 80),
    lastMessageAt: last.sentAt,
    unreadCount: conv.unreadCount,
    mailboxId: conv.mailboxId,
  }
}

/** 详情投影（06 §1.2：上下文头部 + messages） */
function toDetail(conv: (typeof mockConversations)[number]): ConversationDetail {
  return {
    conversationId: conv.conversationId,
    customerId: conv.customerId,
    companyName: conv.companyName,
    contactName: conv.contactName,
    stage: conv.stage,
    mailboxId: conv.mailboxId,
    messages: conv.messages,
  }
}

/** Copilot 投影（06 §1.3；suggestions 已按 D8 在数据侧收口：不产出「创建报价」） */
function toCopilot(conv: (typeof mockConversations)[number]): CopilotData {
  return {
    intent: conv.intent,
    purchaseProbability: conv.purchaseProbability,
    stage: conv.stage,
    suggestions: conv.suggestions,
    citations: citationsOf(conv),
    insight: conv.copilotInsight,
  }
}

/** AI 草稿响应（06 §3.2；citations 空且 missingKnowledge=true → D9 兜底提示） */
function buildAiDraft(
  conv: (typeof mockConversations)[number],
  basedOnMessageId: string,
  instruction?: string,
): AiDraft {
  const content = buildAiDraftContent(conv, instruction)
  const draftMessage: ConversationMessage = appendDraftMessage(conv, content, basedOnMessageId)
  return {
    draftId: draftMessage.messageId,
    content: draftMessage.content,
    basedOnMessageId,
    generatedAt: draftMessage.sentAt,
    citations: citationsOf(conv),
    ...(conv.missingKnowledge ? { missingKnowledge: true } : {}),
  }
}

/** 06 AI 销售工作台（06 接口文档 v0.2 §2/§3） */
export const conversationHandlers = [
  http.get('/api/v1/conversations', async ({ request }) => {
    await delay(LATENCY)
    const url = new URL(request.url)
    const keyword = url.searchParams.get('keyword')?.toLowerCase()
    const priority = url.searchParams.get('priority')
    const unreadOnly = url.searchParams.get('unreadOnly') === 'true'
    const mailboxId = url.searchParams.get('mailboxId')
    const pageNum = Number(url.searchParams.get('page') ?? 1)
    const pageSize = Number(url.searchParams.get('pageSize') ?? 20)

    let items = [...mockConversations]
    if (keyword) {
      items = items.filter(
        (c) =>
          c.contactName.toLowerCase().includes(keyword) ||
          c.companyName.toLowerCase().includes(keyword) ||
          lastMessageOf(c).content.toLowerCase().includes(keyword),
      )
    }
    if (priority) items = items.filter((c) => c.priority === priority)
    if (unreadOnly) items = items.filter((c) => c.unreadCount > 0)
    // FR-11：多邮箱来信聚合视图，mailboxId 过滤
    if (mailboxId) items = items.filter((c) => c.mailboxId === mailboxId)
    items.sort(
      (a, b) =>
        new Date(lastMessageOf(b).sentAt).getTime() - new Date(lastMessageOf(a).sentAt).getTime(),
    )
    return ok(
      page(
        items.slice((pageNum - 1) * pageSize, pageNum * pageSize).map(toListItem),
        items.length,
        pageNum,
        pageSize,
      ),
    )
  }),

  http.get('/api/v1/conversations/:id', async ({ params }) => {
    await delay(LATENCY)
    const conv = findConversation(String(params.id))
    if (!conv) return fail(ErrorCode.NOT_FOUND, '会话不存在或已被删除')
    // mock 便利语义：拉取即清零未读（真实实现应为独立已读上报端点）
    markConversationRead(conv.conversationId)
    return ok(toDetail(conv))
  }),

  http.get('/api/v1/conversations/:id/copilot', async ({ params }) => {
    await delay(LATENCY)
    const conv = findConversation(String(params.id))
    if (!conv) return fail(ErrorCode.NOT_FOUND, '会话不存在或已被删除')
    return ok(toCopilot(conv))
  }),

  http.post('/api/v1/conversations/:id/ai-draft', async ({ request, params }) => {
    await delay(LATENCY)
    const conv = findConversation(String(params.id))
    if (!conv) return fail(ErrorCode.NOT_FOUND, '会话不存在或已被删除')
    const body = await readJson<{ basedOnMessageId?: string; instruction?: string }>(request)
    if (!body.basedOnMessageId) return fail(ErrorCode.BAD_REQUEST, 'basedOnMessageId 为必填项')
    return ok(buildAiDraft(conv, body.basedOnMessageId, body.instruction))
  }),

  http.post('/api/v1/conversations/:id/ai-draft/regenerate', async ({ request, params }) => {
    await delay(LATENCY)
    const conv = findConversation(String(params.id))
    if (!conv) return fail(ErrorCode.NOT_FOUND, '会话不存在或已被删除')
    const body = await readJson<{ basedOnMessageId?: string; instruction?: string }>(request)
    if (!body.basedOnMessageId) return fail(ErrorCode.BAD_REQUEST, 'basedOnMessageId 为必填项')
    // 重新生成 = 新草稿消息（工程约定：随新 ID 天然隔离，不复用旧草稿）
    return ok(buildAiDraft(conv, body.basedOnMessageId, body.instruction))
  }),

  http.put('/api/v1/messages/:id', async ({ request, params }) => {
    await delay(LATENCY)
    const found = findMessage(String(params.id))
    if (!found) return fail(ErrorCode.NOT_FOUND, '消息不存在')
    if (found.message.status !== 'draft') {
      return fail(ErrorCode.CONFLICT, '仅草稿可编辑')
    }
    const body = await readJson<{ content?: string }>(request)
    if (!body.content?.trim()) return fail(ErrorCode.BAD_REQUEST, '草稿内容不能为空')
    found.message.content = body.content
    // PUT 记录编辑差异用于采纳率统计（06 §4：mock 不落差异表）
    return ok({ messageId: found.message.messageId, status: found.message.status })
  }),

  http.post('/api/v1/conversations/:id/send', async ({ request, params }) => {
    await delay(LATENCY)
    const conv = findConversation(String(params.id))
    if (!conv) return fail(ErrorCode.NOT_FOUND, '会话不存在或已被删除')
    const body = await readJson<{ messageId?: string; content?: string }>(request)
    if (!body.messageId) return fail(ErrorCode.BAD_REQUEST, 'messageId 为必填项')
    const message = conv.messages.find((m) => m.messageId === body.messageId)
    if (!message) return fail(ErrorCode.NOT_FOUND, '消息不存在')
    if (message.status === 'sent') return fail(ErrorCode.CONFLICT, '该消息已发送，请勿重复发送')
    if (message.status === 'waiting_approval') {
      return fail(ErrorCode.CONFLICT, '该消息正在等待审核，不可重复提交')
    }
    // 最终编辑内容回写（06 §3.3：content 为最终编辑后内容）
    if (body.content?.trim()) message.content = body.content

    // 分支 A：低风险策略直接发送（conv_2 autoSend 演示）
    if (conv.autoSend) {
      message.status = 'sent'
      message.sentAt = new Date().toISOString()
      return ok({
        messageId: message.messageId,
        status: 'sent',
        sentAt: message.sentAt,
      } satisfies SendResp)
    }

    // 分支 B：审批策略要求审核 → 消息置等待审核 + 注册审批单（12 联动）
    const approvalId = registerEmailSendApproval({
      conversationId: conv.conversationId,
      customerId: conv.customerId,
      customerName: conv.companyName,
      contactName: conv.contactName,
      subject: `Re: ${conv.companyName} inquiry`,
      content: message.content,
      messageId: message.messageId,
    })
    message.status = 'waiting_approval'
    message.approvalId = approvalId
    return ok({
      messageId: message.messageId,
      status: 'draft' as const,
      approval: { approvalId, approvalType: 'email_send' as const, status: 'pending' as const },
    } satisfies SendResp)
  }),

  http.post('/api/v1/conversations/:id/ask-ai', async ({ request, params }) => {
    await delay(LATENCY)
    const conv = findConversation(String(params.id))
    if (!conv) return fail(ErrorCode.NOT_FOUND, '会话不存在或已被删除')
    const body = await readJson<{ question?: string }>(request)
    if (!body.question?.trim()) return fail(ErrorCode.BAD_REQUEST, '请输入问题')
    return ok(buildAskAiAnswer(conv))
  }),

  http.post('/api/v1/copilot/suggestions/apply', async ({ request }) => {
    await delay(LATENCY)
    const body = await readJson<{
      conversationId?: string
      suggestionIds?: string[]
      mode?: 'insert_draft' | 'create_tasks'
    }>(request)
    if (!body.conversationId) return fail(ErrorCode.BAD_REQUEST, 'conversationId 为必填项')
    if (!body.suggestionIds?.length) return fail(ErrorCode.BAD_REQUEST, '请至少勾选一条建议')
    const conv = findConversation(body.conversationId)
    if (!conv) return fail(ErrorCode.NOT_FOUND, '会话不存在或已被删除')

    const labels = conv.suggestions
      .filter((s) => body.suggestionIds!.includes(s.suggestionId))
      .map((s) => s.label)

    // 内容型 → insert_draft 合并为要点；流程型 → create_tasks（06 §3.4 澄清）
    if (body.mode === 'insert_draft') {
      // 与真实后端对齐：合并进当前草稿（无草稿则新建），返回合并后全文 + 草稿消息 id
      const drafts = conv.messages.filter((m) => m.status === 'draft')
      const existing = drafts[drafts.length - 1]
      const draftContent = mergeSuggestionsIntoDraft(labels, existing?.content)
      const draft = existing ?? appendDraftMessage(conv, draftContent, '')
      draft.content = draftContent
      return ok({ draftContent, draftId: draft.messageId })
    }
    if (body.mode === 'create_tasks') {
      return ok({ taskIds: labels.map(() => nextId('task')) })
    }
    return fail(ErrorCode.BAD_REQUEST, 'mode 仅支持 insert_draft / create_tasks')
  }),
]
