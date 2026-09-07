/** 06 AI 销售工作台 API（06 接口文档 v0.2 §2 接口清单） */
import type { PageResp } from '@/api/types/common'
import type {
  AiDraft,
  AiDraftReq,
  AskAiReq,
  AskAiResp,
  ConversationDetail,
  ConversationListReq,
  ConversationListItem,
  CopilotData,
  SendResp,
  SuggestionsApplyReq,
  SuggestionsApplyResp,
} from '@/api/types/conversations'

import { request } from '../http'

/** GET /conversations：会话列表（搜索/优先级/未读/邮箱筛选，FR-11 多邮箱聚合） */
export function fetchConversations(params: ConversationListReq) {
  return request<PageResp<ConversationListItem>>({ url: '/conversations', method: 'GET', params })
}

/** GET /conversations/{id}：会话上下文 + 消息列表 */
export function fetchConversationDetail(conversationId: string) {
  return request<ConversationDetail>({
    url: `/conversations/${conversationId}`,
    method: 'GET',
  })
}

/** GET /conversations/{id}/copilot：Copilot 数据（意图/概率/建议） */
export function fetchCopilot(conversationId: string) {
  return request<CopilotData>({ url: `/conversations/${conversationId}/copilot`, method: 'GET' })
}

/** POST /conversations/{id}/ai-draft：生成 AI 草稿（citations 空 → missingKnowledge 提示） */
export function generateAiDraft(conversationId: string, data: AiDraftReq) {
  return request<AiDraft>({ url: `/conversations/${conversationId}/ai-draft`, method: 'POST', data })
}

/** POST /conversations/{id}/ai-draft/regenerate：重新生成（同 ai-draft 契约） */
export function regenerateAiDraft(conversationId: string, data: AiDraftReq) {
  return request<AiDraft>({
    url: `/conversations/${conversationId}/ai-draft/regenerate`,
    method: 'POST',
    data,
  })
}

/** PUT /messages/{id}：编辑/保存草稿（编辑差异由服务端沉淀，采纳率统计） */
export function updateMessage(messageId: string, data: { content: string }) {
  return request<{ messageId: string; status: 'draft' }>({
    url: `/messages/${messageId}`,
    method: 'PUT',
    data,
  })
}

/** POST /conversations/{id}/send：发送邮件（服务端按审批策略决定分支 A/B，06 §4） */
export function sendMessage(
  conversationId: string,
  data: { messageId: string; content: string },
) {
  return request<SendResp>({ url: `/conversations/${conversationId}/send`, method: 'POST', data })
}

/** POST /conversations/{id}/ask-ai：Ask AI（RAG 检索客户会话/知识库） */
export function askAi(conversationId: string, data: AskAiReq) {
  return request<AskAiResp>({
    url: `/conversations/${conversationId}/ask-ai`,
    method: 'POST',
    data,
  })
}

/** POST /copilot/suggestions/apply：执行勾选建议（内容型插入草稿 / 流程型创建任务） */
export function applySuggestions(data: SuggestionsApplyReq) {
  return request<SuggestionsApplyResp>({
    url: '/copilot/suggestions/apply',
    method: 'POST',
    data,
  })
}
