import type { InsightCitation } from '@/api/types/insight'

/**
 * 06 AI 销售工作台接口契约（06 接口文档 v0.2 §1/§2/§3）：
 * 会话列表（FR-11 多邮箱聚合）/ 会话消息 / AI 草稿 / Copilot / 发送审批分支。
 */

/** 会话优先级（FR-01：🔥 高优 / 🟢 正常 / 🟡 待处理） */
export type ConversationPriority = 'high' | 'normal' | 'pending'

/** 消息方向：in 客户来信 / out 我方外发 */
export type MessageDirection = 'in' | 'out'

/**
 * 消息状态（06 §1.2）：sent 已发送 / draft 草稿（含 AI 草稿与人工暂存）/
 * failed 发送失败 / waiting_approval 已提交等待审核（send 分支 B 联动态）。
 */
export type MessageStatus = 'sent' | 'draft' | 'failed' | 'waiting_approval'

/** GET /conversations 行（06 §1.1，9 字段） */
export interface ConversationListItem {
  conversationId: string
  contactName: string
  companyName: string
  priority: ConversationPriority
  lastMessagePreview: string
  lastMessageAt: string
  unreadCount: number
  /** 来源邮箱标识（FR-11 多邮箱聚合） */
  mailboxId?: string
}

/** 会话消息（06 §1.2 messages[]） */
export interface ConversationMessage {
  messageId: string
  direction: MessageDirection
  senderName: string
  content: string
  /** 检测语言（最近一条 in 消息决定回复语言，工程约定） */
  language?: string
  sentAt: string
  status: MessageStatus
  /** 消息关联的审批单（waiting_approval 态展示跳转依据） */
  approvalId?: string
}

/** GET /conversations/{id}：会话上下文 + 消息列表（06 §1.2） */
export interface ConversationDetail {
  conversationId: string
  customerId: string
  companyName: string
  contactName: string
  stage: string
  mailboxId?: string
  messages: ConversationMessage[]
}

/** AI 草稿（06 §1.2 aiDraft / §3.2 响应） */
export interface AiDraft {
  draftId: string
  content: string
  basedOnMessageId: string
  generatedAt: string
  citations: InsightCitation[]
  /** 知识库无依据（D9 兜底：提示补充资料，禁止编造参数，06 §4） */
  missingKnowledge?: boolean
}

/** Copilot 推荐动作（06 §1.3 勾选式建议；D8 P0 不产出「创建报价」流程型） */
export interface CopilotSuggestion {
  suggestionId: string
  label: string
  checked: boolean
  /** 建议类别：content 内容型（insert_draft）/ process 流程型（create_tasks） */
  kind: 'content' | 'process'
  /** 流程型动作标识（如 create_task；P0 不产出 create_quote） */
  action?: string
}

/** GET /conversations/{id}/copilot（06 §1.3） */
export interface CopilotData {
  intent: 'rfq' | 'price_compare' | 'logistics' | 'sample' | 'other'
  purchaseProbability: number
  stage: string
  suggestions: CopilotSuggestion[]
  citations: InsightCitation[]
  insight: {
    confidence: number
    reasons: { text: string; evidence?: string; source?: string }[]
  }
}

/** POST /conversations/{id}/ai-draft 请求（06 §3.2） */
export interface AiDraftReq {
  basedOnMessageId: string
  instruction?: string
}

/** POST /conversations/{id}/send 响应双分支（06 §3.3） */
export type SendResp =
  | { messageId: string; status: 'sent'; sentAt: string }
  | {
      messageId: string
      status: 'draft'
      approval: { approvalId: string; approvalType: 'email_send'; status: 'pending' }
    }

/** POST /copilot/suggestions/apply（06 §3.4：内容型 insert_draft / 流程型 create_tasks） */
export interface SuggestionsApplyReq {
  conversationId: string
  suggestionIds: string[]
  mode: 'insert_draft' | 'create_tasks'
}

export interface SuggestionsApplyResp {
  /** insert_draft：合并插入后的草稿全文 */
  draftContent?: string
  /** insert_draft：草稿消息 id（无草稿时服务端新建，前端据此回填真实 id） */
  draftId?: string
  /** create_tasks：生成任务 ID */
  taskIds?: string[]
}

/** POST /conversations/{id}/ask-ai（06 §3.5 RAG 检索） */
export interface AskAiReq {
  question: string
}

export interface AskAiResp {
  answer: string
  citations: InsightCitation[]
}

/** 会话列表查询参数（06 §3.1） */
export interface ConversationListReq {
  keyword?: string
  priority?: ConversationPriority
  unreadOnly?: boolean
  mailboxId?: string
  page?: number
  pageSize?: number
}
