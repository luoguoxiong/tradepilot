/**
 * 06 AI 销售工作台契约测试（06 接口文档 v0.2 §1/§2/§3）：
 * 覆盖会话列表（四过滤/三邮箱聚合）/ 会话详情与消息 / AI 草稿（citations + missingKnowledge）/
 * 草稿编辑 / send 双分支（A 直发 / B 审批联动 12）/ Ask AI / 建议执行双模式（D8 断言）。
 *
 * 测试顺序有状态依赖（同文件内共享 mock 内存态，vitest 文件间隔离）。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/mocks/utils', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, LATENCY: 0 }
})

import type { PageResp } from '@/api/types/common'
import type {
  AiDraft,
  AskAiResp,
  ConversationDetail,
  ConversationListItem,
  CopilotData,
  SendResp,
  SuggestionsApplyResp,
} from '@/api/types/conversations'

import { api, contractServer, expectFail, expectOk, expectPage } from './_server'

beforeAll(() => contractServer.listen({ onUnhandledRequest: 'error' }))
afterEach(() => contractServer.resetHandlers())
afterAll(() => contractServer.close())

describe('GET /conversations 会话列表契约（06 §3.1 / FR-11）', () => {
  it('统一 envelope + 分页结构 + 行 9 字段齐备', async () => {
    const { json } = await api<PageResp<ConversationListItem>>('/conversations')
    const data = expectOk(json)
    const result = expectPage<ConversationListItem>(data)
    expect(result.total).toBeGreaterThanOrEqual(9)
    const row = result.list[0]
    for (const key of [
      'conversationId',
      'contactName',
      'companyName',
      'priority',
      'lastMessagePreview',
      'lastMessageAt',
      'unreadCount',
      'mailboxId',
    ]) {
      expect(key in row, `缺少字段 ${key}`).toBe(true)
    }
  })

  it('keyword/priority/unreadOnly 三过滤生效', async () => {
    const kw = expectOk(
      (await api<PageResp<ConversationListItem>>('/conversations?keyword=running%20pro')).json,
    )
    expect(kw.list.length).toBeGreaterThan(0)
    expect(kw.list.every((c) => c.companyName === 'Running Pro')).toBe(true)

    const high = expectOk(
      (await api<PageResp<ConversationListItem>>('/conversations?priority=high')).json,
    )
    expect(high.list.every((c) => c.priority === 'high')).toBe(true)

    const unread = expectOk(
      (await api<PageResp<ConversationListItem>>('/conversations?unreadOnly=true')).json,
    )
    expect(unread.list.every((c) => c.unreadCount > 0)).toBe(true)
    expect(unread.list.length).toBeGreaterThan(0)
  })

  it('mailboxId 过滤 + 多邮箱来源聚合（mb-1/mb-2/mb-3 均出现，FR-11）', async () => {
    const all = expectOk((await api<PageResp<ConversationListItem>>('/conversations?pageSize=50')).json)
    const sources = new Set(all.list.map((c) => c.mailboxId))
    expect(sources.has('mb-1')).toBe(true)
    expect(sources.has('mb-2')).toBe(true)
    expect(sources.has('mb-3')).toBe(true)

    const mb3 = expectOk(
      (await api<PageResp<ConversationListItem>>('/conversations?mailboxId=mb-3')).json,
    )
    expect(mb3.list.length).toBeGreaterThan(0)
    expect(mb3.list.every((c) => c.mailboxId === 'mb-3')).toBe(true)
  })
})

describe('GET /conversations/{id} 会话详情契约（06 §1.2）', () => {
  it('详情字段 + 消息字段齐备；拉取后未读清零（mock 便利语义）', async () => {
    const before = expectOk(
      (await api<PageResp<ConversationListItem>>('/conversations?keyword=abc%20sports&pageSize=50')).json,
    )
    const conv1 = before.list.find((c) => c.conversationId === 'conv_1')
    expect(conv1?.unreadCount).toBeGreaterThan(0)

    const { json } = await api<ConversationDetail>('/conversations/conv_1')
    const detail = expectOk(json)
    expect(detail.customerId).toBe('cus_1')
    expect(detail.companyName).toBe('ABC Sports')
    expect(detail.stage).toBe('negotiation')
    expect(detail.messages.length).toBeGreaterThan(0)
    for (const key of ['messageId', 'direction', 'senderName', 'content', 'sentAt', 'status']) {
      expect(key in detail.messages[0], `消息缺少字段 ${key}`).toBe(true)
    }

    const after = expectOk(
      (await api<PageResp<ConversationListItem>>('/conversations?keyword=abc%20sports&pageSize=50')).json,
    )
    expect(after.list.find((c) => c.conversationId === 'conv_1')?.unreadCount).toBe(0)
  })

  it('不存在会话返回 40401', async () => {
    const { json } = await api('/conversations/conv_none')
    expectFail(json, 40401)
  })
})

describe('AI 草稿契约（06 §3.2）', () => {
  it('生成草稿：draftId/content/basedOnMessageId/generatedAt/citations 齐备', async () => {
    const { json } = await api<AiDraft>('/conversations/conv_1/ai-draft', {
      method: 'POST',
      body: JSON.stringify({ basedOnMessageId: 'msg_5' }),
    })
    const draft = expectOk(json)
    expect(draft.draftId).toBeTruthy()
    expect(draft.basedOnMessageId).toBe('msg_5')
    expect(draft.content).toContain('MOQ')
    expect(draft.citations.length).toBeGreaterThan(0)
    expect(draft.citations[0].docId).toBeTruthy()
    expect(draft.missingKnowledge).toBeUndefined()
  })

  it('conv_5 知识无依据：missingKnowledge=true 且 citations 空（D9）', async () => {
    const { json } = await api<AiDraft>('/conversations/conv_5/ai-draft', {
      method: 'POST',
      body: JSON.stringify({ basedOnMessageId: 'msg_x' }),
    })
    const draft = expectOk(json)
    expect(draft.missingKnowledge).toBe(true)
    expect(draft.citations).toHaveLength(0)
  })

  it('instruction 透传；regenerate 产出新 draftId', async () => {
    const first = expectOk(
      (
        await api<AiDraft>('/conversations/conv_1/ai-draft', {
          method: 'POST',
          body: JSON.stringify({ basedOnMessageId: 'msg_5', instruction: '强调 MOQ 优势' }),
        })
      ).json,
    )
    expect(first.content).toContain('强调 MOQ 优势')

    const second = expectOk(
      (
        await api<AiDraft>('/conversations/conv_1/ai-draft/regenerate', {
          method: 'POST',
          body: JSON.stringify({ basedOnMessageId: 'msg_5' }),
        })
      ).json,
    )
    expect(second.draftId).not.toBe(first.draftId)
  })

  it('缺 basedOnMessageId 返回 40001；未知会话 40401', async () => {
    const missing = await api('/conversations/conv_1/ai-draft', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expectFail(missing.json, 40001)
    const notFound = await api('/conversations/conv_none/ai-draft', {
      method: 'POST',
      body: JSON.stringify({ basedOnMessageId: 'msg_1' }),
    })
    expectFail(notFound.json, 40401)
  })
})

describe('PUT /messages/{id} 草稿编辑契约（06 §1.2 draftActions）', () => {
  it('草稿内容更新回读一致', async () => {
    const draft = expectOk(
      (
        await api<AiDraft>('/conversations/conv_1/ai-draft', {
          method: 'POST',
          body: JSON.stringify({ basedOnMessageId: 'msg_5' }),
        })
      ).json,
    )
    const updated = expectOk(
      (
        await api<{ messageId: string; status: string }>(`/messages/${draft.draftId}`, {
          method: 'PUT',
          body: JSON.stringify({ content: 'Dear Mike, revised content.' }),
        })
      ).json,
    )
    expect(updated.status).toBe('draft')

    const detail = expectOk((await api<ConversationDetail>('/conversations/conv_1')).json)
    const message = detail.messages.find((m) => m.messageId === draft.draftId)
    expect(message?.content).toBe('Dear Mike, revised content.')
  })

  it('非草稿消息不可编辑 40901；未知消息 40401', async () => {
    const detail = expectOk((await api<ConversationDetail>('/conversations/conv_2')).json)
    const sent = detail.messages.find((m) => m.status === 'sent')!
    const conflict = await api(`/messages/${sent.messageId}`, {
      method: 'PUT',
      body: JSON.stringify({ content: 'x' }),
    })
    expectFail(conflict.json, 40901)

    const notFound = await api('/messages/msg_none', {
      method: 'PUT',
      body: JSON.stringify({ content: 'x' }),
    })
    expectFail(notFound.json, 40401)
  })
})

describe('POST /conversations/{id}/send 发送双分支契约（06 §3.3 + 12 联动）', () => {
  it('分支 A（低风险策略）：status=sent + sentAt', async () => {
    const draft = expectOk(
      (
        await api<AiDraft>('/conversations/conv_2/ai-draft', {
          method: 'POST',
          body: JSON.stringify({ basedOnMessageId: 'msg_2' }),
        })
      ).json,
    )
    const { json } = await api<SendResp>('/conversations/conv_2/send', {
      method: 'POST',
      body: JSON.stringify({ messageId: draft.draftId, content: draft.content }),
    })
    const sent = expectOk(json)
    expect(sent.status).toBe('sent')
    expect('sentAt' in sent && typeof sent.sentAt).toBe('string')

    const detail = expectOk((await api<ConversationDetail>('/conversations/conv_2')).json)
    expect(detail.messages.find((m) => m.messageId === draft.draftId)?.status).toBe('sent')
  })

  it('分支 B（审批策略）：approval 载荷 + 12 列表出现 email_send 新单 + 消息等待审核态', async () => {
    const before = expectOk(
      (await api<PageResp<ConversationListItem>>('/approvals?type=email_send&status=pending')).json as never,
    ) as unknown as PageResp<{ approvalId: string }>
    const beforeCount = before.total

    const draft = expectOk(
      (
        await api<AiDraft>('/conversations/conv_1/ai-draft', {
          method: 'POST',
          body: JSON.stringify({ basedOnMessageId: 'msg_5' }),
        })
      ).json,
    )
    const { json } = await api<SendResp>('/conversations/conv_1/send', {
      method: 'POST',
      body: JSON.stringify({ messageId: draft.draftId, content: draft.content }),
    })
    const branch = expectOk(json)
    expect(branch.status).toBe('draft')
    expect('approval' in branch).toBe(true)
    if (!('approval' in branch)) return
    expect(branch.approval.approvalType).toBe('email_send')
    expect(branch.approval.status).toBe('pending')
    expect(branch.approval.approvalId).toBeTruthy()

    // 跨 handler 联动：审批列表出现新单（12 §3.2）
    const after = expectOk(
      (
        await api<PageResp<{ approvalId: string; approvalType: string; status: string }>>(
          '/approvals?type=email_send&status=pending',
        )
      ).json,
    )
    expect(after.total).toBe(beforeCount + 1)
    expect(after.list.some((a) => a.approvalId === branch.approval.approvalId)).toBe(true)

    const detail = expectOk((await api<ConversationDetail>('/conversations/conv_1')).json)
    const message = detail.messages.find((m) => m.messageId === draft.draftId)
    expect(message?.status).toBe('waiting_approval')
    expect(message?.approvalId).toBe(branch.approval.approvalId)

    // 重复提交 → 40901
    const repeat = await api('/conversations/conv_1/send', {
      method: 'POST',
      body: JSON.stringify({ messageId: draft.draftId, content: draft.content }),
    })
    expectFail(repeat.json, 40901)
  })
})

describe('Ask AI 与建议执行契约（06 §3.4/§3.5）', () => {
  it('ask-ai：answer + citations；conv_5 无依据时 citations 空', async () => {
    const answer = expectOk(
      (
        await api<AskAiResp>('/conversations/conv_1/ask-ai', {
          method: 'POST',
          body: JSON.stringify({ question: '客户上次报价多少？' }),
        })
      ).json,
    )
    expect(answer.answer).toBeTruthy()
    expect(answer.citations.length).toBeGreaterThan(0)

    const noBasis = expectOk(
      (
        await api<AskAiResp>('/conversations/conv_5/ask-ai', {
          method: 'POST',
          body: JSON.stringify({ question: '报价历史？' }),
        })
      ).json,
    )
    expect(noBasis.citations).toHaveLength(0)
  })

  it('suggestions/apply：insert_draft 合并要点 / create_tasks 生成任务', async () => {
    const copilot = expectOk(
      (await api<CopilotData>('/conversations/conv_1/copilot')).json,
    )
    expect(copilot.intent).toBe('rfq')
    expect(copilot.purchaseProbability).toBeGreaterThan(0)
    expect(copilot.suggestions.length).toBeGreaterThan(0)

    const ids = copilot.suggestions.filter((s) => s.kind === 'content').map((s) => s.suggestionId)
    const draftApply = expectOk(
      (
        await api<SuggestionsApplyResp>('/copilot/suggestions/apply', {
          method: 'POST',
          body: JSON.stringify({ conversationId: 'conv_1', suggestionIds: ids, mode: 'insert_draft' }),
        })
      ).json,
    )
    expect(draftApply.draftContent).toBeTruthy()

    const taskApply = expectOk(
      (
        await api<SuggestionsApplyResp>('/copilot/suggestions/apply', {
          method: 'POST',
          body: JSON.stringify({
            conversationId: 'conv_1',
            suggestionIds: copilot.suggestions.filter((s) => s.kind === 'process').map((s) => s.suggestionId),
            mode: 'create_tasks',
          }),
        })
      ).json,
    )
    expect(taskApply.taskIds?.length).toBeGreaterThan(0)
  })

  it('D8：P0 推荐动作不产出「创建报价」流程型建议；空 suggestionIds 返回 40001', async () => {
    for (const conv of ['conv_1', 'conv_3', 'conv_4', 'conv_5', 'conv_7', 'conv_9']) {
      const copilot = expectOk((await api<CopilotData>(`/conversations/${conv}/copilot`)).json)
      const processSuggestions = copilot.suggestions.filter((s) => s.kind === 'process')
      expect(processSuggestions.every((s) => s.action !== 'create_quote'), `${conv} 产出 create_quote`).toBe(true)
    }
    const empty = await api('/copilot/suggestions/apply', {
      method: 'POST',
      body: JSON.stringify({ conversationId: 'conv_1', suggestionIds: [], mode: 'insert_draft' }),
    })
    expectFail(empty.json, 40001)
  })
})
