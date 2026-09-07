import { nextId } from './db'
import type {
  ConversationMessage,
  ConversationPriority,
  CopilotSuggestion,
} from '@/api/types/conversations'
import type { InsightCitation, InsightReason } from '@/api/types/insight'

/**
 * M5 会话 mock 内存态（06 接口文档 v0.2 §1/§3；06 §5.3 mock 即契约）：
 * - 9 会话覆盖：priority 三档 / unread / 多语言 en+de+zh / 草稿 / failed / 长线程；
 * - conv_1 → send 分支 B（审批）；conv_2 → 分支 A（autoSend 直发）；conv_5 → missingKnowledge（D9）；
 * - 建议均为内容型 + 预约跟进（D8：P0 不产出「创建报价」流程型建议，数据侧收口）；
 * - doc_3 为软删文档（knowledge mock），conv_7 引用验证「已删除」禁跳链路。
 */

const NOW = Date.now()
/** 相对当前时间生成 ISO（每次刷新种子时间滚动，相对时间展示稳定） */
export function ago(minutesAgo: number): string {
  return new Date(NOW - minutesAgo * 60_000).toISOString()
}

interface MockConversation {
  conversationId: string
  customerId: string
  companyName: string
  contactName: string
  stage: string
  mailboxId: string
  priority: ConversationPriority
  unreadCount: number
  /** true → send 分支 A（低风险策略直发，06 §3.3），其余会话走分支 B */
  autoSend?: boolean
  /** true → ai-draft 返回 missingKnowledge（D9 知识库无依据兜底） */
  missingKnowledge?: boolean
  intent: 'rfq' | 'price_compare' | 'logistics' | 'sample' | 'other'
  purchaseProbability: number
  copilotInsight: { confidence: number; reasons: InsightReason[] }
  suggestions: CopilotSuggestion[]
  knowledgeRefs: InsightCitation[]
  messages: ConversationMessage[]
}

export type { MockConversation }

let msgSeq = 1
function msg(input: {
  direction: 'in' | 'out'
  senderName: string
  content: string
  language?: string
  minutesAgo: number
  status?: ConversationMessage['status']
  approvalId?: string
}): ConversationMessage {
  msgSeq += 1
  return {
    messageId: `msg_${msgSeq}`,
    direction: input.direction,
    senderName: input.senderName,
    content: input.content,
    language: input.language,
    sentAt: ago(input.minutesAgo),
    status: input.status ?? 'sent',
    ...(input.approvalId ? { approvalId: input.approvalId } : {}),
  }
}

const SUGGESTIONS_RFQ: CopilotSuggestion[] = [
  { suggestionId: 'sg_1', label: '回复报价范围', checked: false, kind: 'content' },
  { suggestionId: 'sg_2', label: '询问采购数量', checked: false, kind: 'content' },
  { suggestionId: 'sg_3', label: '推荐产品', checked: false, kind: 'content' },
  { suggestionId: 'sg_4', label: '预约跟进会议', checked: false, kind: 'process', action: 'create_task' },
]

const SUGGESTIONS_SAMPLE: CopilotSuggestion[] = [
  { suggestionId: 'sg_5', label: '说明样品流程与费用', checked: false, kind: 'content' },
  { suggestionId: 'sg_6', label: '询问目标规格', checked: false, kind: 'content' },
]

export const mockConversations: MockConversation[] = [
  {
    conversationId: 'conv_1',
    customerId: 'cus_1',
    companyName: 'ABC Sports',
    contactName: 'Mike Chen',
    stage: 'negotiation',
    mailboxId: 'mb-1',
    priority: 'high',
    unreadCount: 1,
    intent: 'rfq',
    purchaseProbability: 88,
    copilotInsight: {
      confidence: 0.9,
      reasons: [
        { text: '邮件包含明确询价与 MOQ 问题', evidence: '"price and MOQ"', source: 'email_parser' },
        { text: '客户为北美头部零售商，历史复购 2 次', evidence: 'CRM 订单记录', source: 'crm' },
      ],
    },
    suggestions: SUGGESTIONS_RFQ,
    knowledgeRefs: [
      { docId: 'doc_1', docName: 'Carbon Fiber Catalog.pdf', chunkId: 'chk_12' },
      { docId: 'doc_2', docName: 'ABC Sports - Company Profile.pdf', chunkId: 'chk_3' },
    ],
    messages: [
      msg({
        direction: 'in',
        senderName: 'Mike Chen',
        content:
          'Hi, this is Mike from ABC Sports. We saw your carbon fiber insoles at the Expo. Can you send me your price and MOQ for wholesale?',
        language: 'en',
        minutesAgo: 180,
      }),
      msg({
        direction: 'out',
        senderName: 'Ace · 外贸销售员',
        content:
          'Dear Mike, thanks for reaching out at the Expo. Could you share your target quantity and models? I will prepare a tailored quotation right away.',
        language: 'en',
        minutesAgo: 160,
      }),
      msg({
        direction: 'in',
        senderName: 'Mike Chen',
        content:
          "Sure. We're looking at the CF-Pro model, around 3000-5000 pairs for the first order. What's your best price?",
        language: 'en',
        minutesAgo: 90,
      }),
      msg({
        direction: 'in',
        senderName: 'Mike Chen',
        content: 'Also, what is the lead time for the first shipment? Our Q4 plan depends on it.',
        language: 'en',
        minutesAgo: 45,
      }),
    ],
  },
  {
    conversationId: 'conv_2',
    customerId: 'cus_1',
    companyName: 'ABC Sports',
    contactName: 'Sarah Lee',
    stage: 'negotiation',
    mailboxId: 'mb-1',
    priority: 'normal',
    unreadCount: 0,
    autoSend: true,
    intent: 'other',
    purchaseProbability: 64,
    copilotInsight: {
      confidence: 0.72,
      reasons: [{ text: '年度框架沟通，无即时采购信号', evidence: '最近 30 天无询价', source: 'crm' }],
    },
    suggestions: SUGGESTIONS_SAMPLE,
    knowledgeRefs: [{ docId: 'doc_2', docName: 'ABC Sports - Company Profile.pdf', chunkId: 'chk_1' }],
    messages: [
      msg({
        direction: 'in',
        senderName: 'Sarah Lee',
        content: 'Hi, following up on our annual framework agreement. Anything new for next season?',
        language: 'en',
        minutesAgo: 3 * 24 * 60,
      }),
      msg({
        direction: 'out',
        senderName: 'Ace · 外贸销售员',
        content:
          'Dear Sarah, we have two new models launching next season. I will send the preview catalog once internal review completes.',
        language: 'en',
        minutesAgo: 3 * 24 * 60 - 30,
      }),
      msg({
        direction: 'in',
        senderName: 'Sarah Lee',
        content: 'Great, looking forward to it. Please also include the sustainability certifications.',
        language: 'en',
        minutesAgo: 2 * 24 * 60,
      }),
    ],
  },
  {
    conversationId: 'conv_3',
    customerId: 'cus_2',
    companyName: 'Running Pro',
    contactName: 'Tom Becker',
    stage: 'contacted',
    mailboxId: 'mb-1',
    priority: 'high',
    unreadCount: 2,
    intent: 'price_compare',
    purchaseProbability: 71,
    copilotInsight: {
      confidence: 0.78,
      reasons: [
        { text: '客户在比较两家供应商报价', evidence: '提及 competitor quote', source: 'email_parser' },
        { text: '决策影响力评分 90', evidence: 'Founder & CEO', source: 'crm' },
      ],
    },
    suggestions: SUGGESTIONS_RFQ,
    knowledgeRefs: [{ docId: 'doc_1', docName: 'Carbon Fiber Catalog.pdf', chunkId: 'chk_8' }],
    messages: [
      msg({
        direction: 'in',
        senderName: 'Tom Becker',
        content: 'We received another offer at $11.80/pair. Can you match it for the CF-Lite model?',
        language: 'en',
        minutesAgo: 300,
      }),
      msg({
        direction: 'out',
        senderName: 'Ace · 外贸销售员',
        content:
          'Hi Tom, thanks for the transparency. Our CF-Lite uses full-length carbon plates — let me check with pricing and come back with a structure that works.',
        language: 'en',
        minutesAgo: 240,
      }),
      msg({
        direction: 'in',
        senderName: 'Tom Becker',
        content: 'Appreciate it. Volume would be 8000 pairs split into two shipments.',
        language: 'en',
        minutesAgo: 120,
      }),
      msg({
        direction: 'in',
        senderName: 'Tom Becker',
        content: 'Any update on the pricing structure?',
        language: 'en',
        minutesAgo: 30,
      }),
      msg({
        direction: 'out',
        senderName: 'Ace · 外贸销售员',
        content:
          'Hi Tom,\n\nThank you for your transparency on the competing offer. Given the 8,000-pair volume across two shipments, we can offer:\n\n• First 4,000 pairs: USD 11.90/pair\n• Remaining 4,000 pairs: USD 11.60/pair\n• Full-length carbon plate retained; lead time 28 days per shipment\n\nThis keeps our material advantage while staying within 1% of the competitor quote.\n\nBest regards',
        language: 'en',
        minutesAgo: 20,
        status: 'waiting_approval',
        approvalId: 'appr_1',
      }),
    ],
  },
  {
    conversationId: 'conv_4',
    customerId: 'cus_3',
    companyName: 'Sport Factory',
    contactName: 'Lukas Weber',
    stage: 'new_lead',
    mailboxId: 'mb-3',
    priority: 'normal',
    unreadCount: 1,
    intent: 'rfq',
    purchaseProbability: 55,
    copilotInsight: {
      confidence: 0.62,
      reasons: [
        { text: '首封来信为德语询盘，意向明确但信息有限', evidence: '"Preisliste und Mindestbestellmenge"', source: 'email_parser' },
      ],
    },
    suggestions: [
      { suggestionId: 'sg_7', label: '回复产品目录', checked: false, kind: 'content' },
      { suggestionId: 'sg_8', label: '询问目标市场与认证需求', checked: false, kind: 'content' },
    ],
    knowledgeRefs: [{ docId: 'doc_1', docName: 'Carbon Fiber Catalog.pdf', chunkId: 'chk_2' }],
    messages: [
      msg({
        direction: 'in',
        senderName: 'Lukas Weber',
        content:
          'Guten Tag, wir sind ein Sportartikelhersteller aus München und interessieren uns für Ihre Einlegesohlen. Bitte senden Sie mir Ihre Preisliste und die Mindestbestellmenge zu.',
        language: 'de',
        minutesAgo: 5 * 60,
      }),
      msg({
        direction: 'out',
        senderName: 'Ace · 外贸销售员',
        content:
          'Sehr geehrter Herr Weber, vielen Dank für Ihre Anfrage. Gerne senden wir Ihnen unseren Katalog sowie Preise ab 500 Paar zu.',
        language: 'de',
        minutesAgo: 4 * 60,
      }),
    ],
  },
  {
    conversationId: 'conv_5',
    customerId: 'cus_4',
    companyName: 'Fit Brand',
    contactName: 'Emma Clark',
    stage: 'cold',
    mailboxId: 'mb-2',
    priority: 'pending',
    unreadCount: 1,
    missingKnowledge: true,
    intent: 'other',
    purchaseProbability: 35,
    copilotInsight: {
      confidence: 0.48,
      reasons: [
        { text: '冷客户试探性回复，采购信号弱', evidence: '10 个月未活跃', source: 'crm' },
        { text: '知识库缺少该客户行业报价依据', evidence: '无命中 chunk', source: 'knowledge_rag' },
      ],
    },
    suggestions: [
      { suggestionId: 'sg_9', label: '询问当前采购计划', checked: false, kind: 'content' },
    ],
    knowledgeRefs: [],
    messages: [
      msg({
        direction: 'in',
        senderName: 'Emma Clark',
        content: 'Hi, we might revisit insoles next year. Do you have any new lines for running?',
        language: 'en',
        minutesAgo: 7 * 60,
      }),
    ],
  },
  {
    conversationId: 'conv_6',
    customerId: 'cus_8',
    companyName: 'Aurora Trading',
    contactName: 'Felix Braun',
    stage: 'contacted',
    mailboxId: 'mb-3',
    priority: 'normal',
    unreadCount: 0,
    intent: 'logistics',
    purchaseProbability: 42,
    copilotInsight: {
      confidence: 0.55,
      reasons: [{ text: '仅物流询问，无采购推进信号', evidence: '"shipping to Hamburg"', source: 'email_parser' }],
    },
    suggestions: [
      { suggestionId: 'sg_10', label: '回复物流时效', checked: false, kind: 'content' },
    ],
    knowledgeRefs: [{ docId: 'doc_1', docName: 'Carbon Fiber Catalog.pdf', chunkId: 'chk_5' }],
    messages: [
      msg({
        direction: 'in',
        senderName: 'Felix Braun',
        content: 'What is the shipping time to Hamburg for a 500-pair order?',
        language: 'en',
        minutesAgo: 6 * 24 * 60,
      }),
      msg({
        direction: 'out',
        senderName: 'Ace · 外贸销售员',
        content: 'Dear Felix, sea freight takes about 32 days to Hamburg, air freight 6-8 days.',
        language: 'en',
        minutesAgo: 6 * 24 * 60 - 40,
      }),
    ],
  },
  {
    conversationId: 'conv_7',
    customerId: 'cus_lead_3',
    companyName: 'London Run Co',
    contactName: 'Oliver Grant',
    stage: 'contacted',
    mailboxId: 'mb-1',
    priority: 'normal',
    unreadCount: 0,
    intent: 'rfq',
    purchaseProbability: 60,
    copilotInsight: {
      confidence: 0.66,
      reasons: [{ text: '历史 RFQ 记录显示持续关注中底科技', evidence: 'RFQ History.pdf', source: 'knowledge_rag' }],
    },
    suggestions: SUGGESTIONS_RFQ,
    knowledgeRefs: [
      { docId: 'doc_3', docName: 'London Run RFQ History.pdf', chunkId: 'chk_21' },
      { docId: 'doc_1', docName: 'Carbon Fiber Catalog.pdf', chunkId: 'chk_9' },
    ],
    messages: [
      msg({
        direction: 'in',
        senderName: 'Oliver Grant',
        content: 'Please quote for our autumn running line — midsole technology is the key differentiator.',
        language: 'en',
        minutesAgo: 9 * 24 * 60,
      }),
      msg({
        direction: 'out',
        senderName: 'Ace · 外贸销售员',
        content:
          'Hi Oliver, attached our carbon midsole specs. Based on your RFQ history, CF-Pro fits the autumn line best.',
        language: 'en',
        minutesAgo: 8 * 24 * 60,
      }),
    ],
  },
  {
    conversationId: 'conv_8',
    customerId: 'cus_lead_12',
    companyName: 'Kanto Shoes',
    contactName: 'Hiro Tanaka',
    stage: 'new_lead',
    mailboxId: 'mb-2',
    priority: 'pending',
    unreadCount: 0,
    intent: 'sample',
    purchaseProbability: 48,
    copilotInsight: {
      confidence: 0.58,
      reasons: [{ text: '希望先取样品验证', evidence: '"サンプル"', source: 'email_parser' }],
    },
    suggestions: SUGGESTIONS_SAMPLE,
    knowledgeRefs: [{ docId: 'doc_1', docName: 'Carbon Fiber Catalog.pdf', chunkId: 'chk_4' }],
    messages: [
      msg({
        direction: 'in',
        senderName: 'Hiro Tanaka',
        content: 'サンプルの送付は可能でしょうか。CF-Pro を 2 ペア希望です。',
        language: 'ja',
        minutesAgo: 2 * 24 * 60,
      }),
      msg({
        direction: 'out',
        senderName: 'Ace · 外贸销售员',
        content: '样品寄送流程确认中（此前一次发送因附件超限失败）。',
        language: 'zh',
        minutesAgo: 2 * 24 * 60 - 60,
        status: 'failed',
      }),
    ],
  },
]

/** conv_9：长线程（56 条，程序化生成）——演示消息窗口化向上翻页（04 §3.2） */
{
  const long: MockConversation = {
    conversationId: 'conv_9',
    customerId: 'cus_2',
    companyName: 'Running Pro',
    contactName: 'Tom Becker',
    stage: 'contacted',
    mailboxId: 'mb-1',
    priority: 'high',
    unreadCount: 0,
    intent: 'price_compare',
    purchaseProbability: 69,
    copilotInsight: {
      confidence: 0.7,
      reasons: [{ text: '长期比价沟通线程', evidence: '56 条往来', source: 'crm' }],
    },
    suggestions: SUGGESTIONS_RFQ,
    knowledgeRefs: [{ docId: 'doc_1', docName: 'Carbon Fiber Catalog.pdf', chunkId: 'chk_7' }],
    messages: [],
  }
  const total = 56
  for (let i = 0; i < total; i += 1) {
    const inbound = i % 3 === 2
    long.messages.push(
      msg({
        direction: inbound ? 'in' : 'out',
        senderName: inbound ? 'Tom Becker' : 'Ace · 外贸销售员',
        content: inbound
          ? `Follow-up #${Math.floor(i / 3) + 1}: any news on the proposal?`
          : `Update #${Math.floor(i / 3) + 1}: package refinement in progress, will revert shortly.`,
        language: 'en',
        minutesAgo: (total - i) * 12 * 60,
      }),
    )
  }
  mockConversations.push(long)
}

// ===== 访问与变更 helper（handler 与 approvals 联动共用） =====

export function findConversation(conversationId: string): MockConversation | undefined {
  return mockConversations.find((c) => c.conversationId === conversationId)
}

export function lastMessageOf(conversation: MockConversation): ConversationMessage {
  return conversation.messages[conversation.messages.length - 1]
}

/** GET detail 的 mock 便利语义：拉取即清零未读（真实实现应为独立已读上报端点） */
export function markConversationRead(conversationId: string): void {
  const conv = findConversation(conversationId)
  if (conv) conv.unreadCount = 0
}

export function findMessage(messageId: string): { conversation: MockConversation; message: ConversationMessage } | undefined {
  for (const conv of mockConversations) {
    const message = conv.messages.find((m) => m.messageId === messageId)
    if (message) return { conversation: conv, message }
  }
  return undefined
}

/** ai-draft：草稿实体化为 status=draft 的会话消息（draftId 即 messageId，06 §1.2） */
export function appendDraftMessage(
  conversation: MockConversation,
  content: string,
  basedOnMessageId: string,
): ConversationMessage {
  const draft = msg({
    direction: 'out',
    senderName: 'Ace · 外贸销售员',
    content,
    language: replyLanguageOf(conversation),
    minutesAgo: 0,
    status: 'draft',
  })
  conversation.messages.push(draft)
  void basedOnMessageId
  return draft
}

/** 回复语言 = 最近一条 in 消息 language，无信号默认英文（06 §7 澄清） */
export function replyLanguageOf(conversation: MockConversation): string {
  for (let i = conversation.messages.length - 1; i >= 0; i -= 1) {
    const m = conversation.messages[i]
    if (m.direction === 'in' && m.language) return m.language
  }
  return 'en'
}

/** 审批批准后回写：消息置已发送（12 §3.3 服务端回调原业务动作） */
export function markMessageSent(conversationId: string, messageId: string): ConversationMessage | undefined {
  const conv = findConversation(conversationId)
  const message = conv?.messages.find((m) => m.messageId === messageId)
  if (!message) return undefined
  message.status = 'sent'
  message.sentAt = new Date().toISOString()
  return message
}

/** 审批拒绝后回退：消息退回草稿态（保持可编辑重发） */
export function markMessageRejected(conversationId: string, messageId: string): void {
  const conv = findConversation(conversationId)
  const message = conv?.messages.find((m) => m.messageId === messageId)
  if (message) message.status = 'draft'
}

/** 知识引用 citations：missingKnowledge 会话返回空（D9：无依据禁止编造，06 §4） */
export function citationsOf(conversation: MockConversation): InsightCitation[] {
  return conversation.missingKnowledge ? [] : conversation.knowledgeRefs
}

/** AI 草稿正文（结构化取数口径见 06 §4：参数仅来自知识中心 citations） */
export function buildAiDraftContent(conversation: MockConversation, instruction?: string): string {
  const contact = conversation.contactName.split(' ')[0]
  if (conversation.missingKnowledge) {
    return `Dear ${contact},\n\nThank you for your message. I am checking our latest product line for you and will revert with concrete details shortly.\n\nBest regards`
  }
  const extra = instruction ? `\n\nP.S. ${instruction}` : ''
  return `Dear ${contact},\n\nThank you for your interest. Based on our Carbon Fiber Catalog:\n\n• CF-Pro full-length carbon plate — MOQ starts from 500 pairs\n• Lead time: 25 days after deposit; sea freight 30 days to your port\n• Wholesale price range: USD 12.50 - 13.80/pair by quantity${extra}\n\nHappy to send samples once you confirm the model.\n\nBest regards`
}

/** 建议合并插入（insert_draft）：逐条要点化（06 §3.4 澄清） */
export function mergeSuggestionsIntoDraft(labels: string[], base?: string): string {
  const points = labels.map((label) => `• ${label}`).join('\n')
  const head = base?.trim() || 'Dear friend,\n\nThank you for your message.'
  return `${head}\n\n${points}`
}

/** Ask AI 应答（RAG：会话 + 知识库检索口径） */
export function buildAskAiAnswer(conversation: MockConversation): { answer: string; citations: InsightCitation[] } {
  if (conversation.missingKnowledge) {
    return {
      answer:
        '知识库中暂无该客户的报价与历史依据记录，建议先补充资料（历史报价单 / 产品目录）后再提问。',
      citations: [],
    }
  }
  return {
    answer: `基于会话与知识库检索：${conversation.contactName} 来自 ${conversation.companyName}，当前会话意图为 ${conversation.intent}，相关产品参数与历史沟通详见引用文档。`,
    citations: conversation.knowledgeRefs,
  }
}

export function nextConversationDraftId(): string {
  return nextId('msg')
}
