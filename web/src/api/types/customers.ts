/** 05 CRM 客户中心 + 04 客户 360°（05 接口文档 §1/§2/§3 · 04 接口文档 §1/§2/§3） */
import type { DataScope, PageReq } from './common'
import type { Insight, InsightCitation, InsightReason } from './insight'
import type { CustomerStage } from '@/utils/enum-map'

/** 客户类型（ER customer_type；添加表单下拉，05 接口文档 §1.2） */
export type CustomerType = 'brand' | 'distributor' | 'factory' | 'other'

/** 客户列表页签（potential / formal 走同一客户列表接口，联系人/活动见各自接口） */
export type CustomerTab = 'potential' | 'formal'

/** 下一步动作（05 接口文档 §1.1）：label 由服务端按 AI/规则生成，前端直出 */
export interface CustomerNextAction {
  type: 'send_quote' | 'follow_up' | 'send_outreach' | 'reactivate_ai'
  label: string
}

/** 客户列表行（05 接口文档 §1.1） */
export interface CustomerItem {
  customerId: string
  companyName: string
  country: string
  industry?: string
  stage: CustomerStage
  /** 客户身份：false 潜在 / true 正式（与 stage 解耦） */
  isFormal: boolean
  ownerId: string
  ownerName: string
  /** 最近活动时间（相对时间展示） */
  lastActivityAt?: string | null
  nextAction?: CustomerNextAction | null
  /** Cold 客户 AI 重新激活建议（Insight Schema） */
  reactivateSuggestion?: Insight<number> | null
  /** 删除待审锁定态（DELETE 生成审批后置位，审批拒绝自动解锁） */
  deleteLocked: boolean
  customerType?: CustomerType | null
  website?: string | null
  remark?: string | null
  createdAt: string
  updatedAt?: string
}

/** 客户详情（GET /customers/{id}，复用 04；编辑表单预填数据源） */
export interface CustomerDetail extends CustomerItem {
  contactsCount: number
}

/** 联系人行（05 接口文档 §1.3；04 客户 360° 同源，含决策影响力 AI 精化证据链） */
export interface ContactItem {
  contactId: string
  name: string
  title?: string | null
  email: string
  customerId: string
  companyName: string
  /** 决策影响力 0~100（90/75/40 职衔档或 AI 精化，未命中 null） */
  decisionInfluencePct?: number | null
  /** AI 精化证据链 `[{ text, evidence, source }]`（04 §1.4：Tooltip 展示；无精化为空） */
  decisionInfluenceReasons?: InsightReason[] | null
  isPrimary?: boolean
}

/** 活动类型（05 接口文档 §1.3，ref_type 见 ER ref_type 多态） */
export type ActivityType =
  'stage_change' | 'owner_change' | 'email' | 'quote' | 'follow_up' | 'note' | 'ai_action'

/** 活动行（05 接口文档 §1.3：全局时间线，客户 360° 同数据口径） */
export interface ActivityItem {
  activityId: string
  type: ActivityType
  summary: string
  customerId?: string | null
  customerName?: string | null
  operatorType: 'ai' | 'user'
  operatorName: string
  refType?: string | null
  refId?: string | null
  createdAt: string
}

// ===== 请求 / 响应 =====

/** GET /customers（05 接口文档 §3.1） */
export interface CustomerListReq extends PageReq {
  tab?: CustomerTab
  keyword?: string
  country?: string
  stage?: CustomerStage
  ownerId?: string
  scope?: DataScope
  /** 超期未联系天数（今日待跟进等入口，05 接口文档 §1.1） */
  overdueDays?: number
}

/** GET /contacts */
export interface ContactListReq extends PageReq {
  keyword?: string
}

/** POST /contacts / PUT /contacts/{id} 请求体（05 接口文档 §2；ER contact：customer_id/name 必填） */
export interface ContactPayload {
  /** 所属客户（创建必填；归属不可变更） */
  customerId: string
  name: string
  title?: string
  /** 公开商务邮箱（org 内唯一，重复 40901） */
  email?: string
}

/** GET /activities（05 接口文档 §3.4） */
export interface ActivityListReq extends PageReq {
  customerId?: string
  type?: ActivityType
  operatorType?: 'ai' | 'user'
  /** 时间范围（ISO 日期） */
  startDate?: string
  endDate?: string
}

/** 添加客户 / 编辑客户请求体（05 接口文档 §1.2 / §3.2 PUT） */
export interface CustomerPayload {
  companyName: string
  country: string
  website?: string
  industry?: string
  customerType?: CustomerType
  /** 客户身份：false 潜在（默认）/ true 正式 */
  isFormal?: boolean
  /** 初始阶段（仅创建使用；默认 new_lead） */
  stage?: CustomerStage
  /** 负责人：新建默认当前操作人；转交仅经理/管理员可改（05 §4） */
  ownerId: string
  /** 联系人子表单（仅创建可带，编辑走联系人接口） */
  contacts?: { name: string; title?: string; email?: string }[]
  remark?: string
}

/** DELETE /customers/{id} 响应：不直接删除，生成 customer_delete 审批（05 §3.3） */
export interface CustomerDeleteResp {
  approvalId: string
  approvalType: 'customer_delete'
  status: 'pending'
}

/** POST /customers/batch-delete（05 §3.5） */
export interface BatchDeleteReq {
  customerIds: string[]
}

export interface BatchDeleteResp {
  approvals: { customerId: string; approvalId: string }[]
  /** 已锁定 / 已删除客户计入 failed */
  failed: { customerId: string; reason: string }[]
}

/** POST /customers/batch-owner（05 §3.5）：仅经理/管理员 */
export interface BatchOwnerReq {
  customerIds: string[]
  ownerId: string
}

export interface BatchOwnerResp {
  updated: number
}

/** POST /customers/{id}/stage（05 §3.2） */
export interface StageChangeReq {
  stage: CustomerStage
  reason?: string
}

export interface StageChangeResp {
  customerId: string
  stage: CustomerStage
  activityId: string
}

// ===================== 04 客户 360° =====================

/** 产品匹配行（04 §1.2/§1.5：进度条 + matchPct；D7 P0 行点击行内抽屉） */
export interface ProductMatchRow {
  productId: string
  productName: string
  matchPct: number
  /** 匹配判断原因（Insight Schema 证据链，D7 抽屉展示） */
  reasons?: InsightReason[]
}

/** 客户 360° Overview 汇总（04 §1.2/§3.1） */
export interface CustomerOverview {
  companySize?: string
  foundedYear?: number
  customerType?: CustomerType | null
  mainProducts?: string[]
  productMatches?: ProductMatchRow[]
}

/** AI 洞察推荐下一步（04 §1.3：点击执行；send_quote 随 D8 按 features 过滤） */
export interface Customer360NextAction {
  type: 'contact_decision_maker' | 'generate_outreach' | 'send_quote'
  label: string
  /** 前两类 → 联系人 id（open contact / 生成开发信目标） */
  targetId?: string
}

/** GET /customers/{id}/insights 响应（04 §3.2，Insight Schema） */
export interface Customer360Insight {
  /** 采购概率（无分析为 null → 引导重新分析） */
  purchaseProbability: Insight<number> | null
  nextAction: Customer360NextAction | null
}

/**
 * GET /customers/{id}（04 §3.1：头部 + Overview）。
 * 双数据源：CRM 客户（inCrm=true，含主数据子集）或获客池 lead 预览（inCrm=false，
 * 数据来自 lead overview/insight/联系人，仅 Overview/Contacts/Products 页签开启）。
 */
export interface Customer360Profile {
  customerId: string
  companyName: string
  /** 评分百分比（🔥 Score；无数据为 undefined → 前端显示 —） */
  score?: number
  country?: string
  website?: string
  industryTags: string[]
  inCrm: boolean
  /** inCrm=true 时的客户主数据子集（可编辑/推进阶段/删除） */
  stage?: CustomerStage
  customerType?: CustomerType | null
  ownerId?: string
  ownerName?: string
  isFormal?: boolean
  deleteLocked?: boolean
  remark?: string
  overview: CustomerOverview
}

/** POST /customers/{id}/analyze（04 §3.3：异步任务；scope=full 精化联系人决策影响力） */
export interface CustomerAnalyzeReq {
  scope: 'overview' | 'full'
}

export interface CustomerAnalyzeResp {
  taskId: string
}

/** 会话行（04 §1.5 Conversations，复用 06；P0 行点击行内详情预览） */
export interface ConversationItem {
  conversationId: string
  /** 渠道邮箱（channel=email） */
  email: string
  subject: string
  lastMessageAt: string
  unreadCount: number
  /** 最新消息摘要（06 交付前行内预览用） */
  lastSnippet?: string
}

/** 客户 360° 产品行（04 §1.5 Products：productMatches + 抽屉详情） */
export interface CustomerProductItem extends ProductMatchRow {
  category?: string
  summary?: string
  highlights?: string[]
  sourceDocs?: InsightCitation[]
}

/** POST /contacts/{id}/generate-outreach 响应（04 §3.4：产出草稿，不直接发送） */
export interface GenerateOutreachResp {
  draftId: string
  conversationId?: string
  content: string
}
