/** AI 获客（03 接口文档）：创建任务 / 发现列表 / 加入 CRM */
import type { TaskStatus } from './tasks'

/** 通用 Insight 结构（00 §4.1）：评分/概率/建议一律携带证据链与置信度 */
export interface InsightReason {
  text: string
  evidence?: string
  source?: string
}

export interface InsightCitation {
  docId: string
  docName: string
  chunkId?: string
}

export interface Insight<TValue = number> {
  value: TValue
  confidence: number
  reasons: InsightReason[]
  citations?: InsightCitation[]
  estimated?: boolean
  generatedAt?: string
}

/** 结构化解析结果（03 §1.3；parse 只产出 4 个基础字段） */
export interface LeadTaskParsed {
  targetMarket: string
  customerType: string
  targetProduct: string
  companySize?: string
}

/** 高级设置（03 §1.3 / 需求 §3.4；默认值来自员工 SOP 高级设置参数） */
export interface LeadAdvancedSettings {
  companySizeRange?: { min?: number; max?: number }
  annualImportRange?: string
  jobTitles?: string[]
  excludeDomains?: string[]
  matchThresholds?: { high: number; medium: number }
}

/** POST /lead-tasks 请求体（03 §3.2） */
export interface CreateLeadTaskReq {
  goalText: string
  parsed: LeadTaskParsed
  advancedSettings?: LeadAdvancedSettings
  targetCount?: number
  employeeId?: string
}

/** POST /lead-tasks/parse 响应（03 §3.1） */
export interface LeadParseResp {
  parsed: LeadTaskParsed
  optimizedGoal: string
  confidence: number
  reasons: InsightReason[]
}

/** 创建任务响应 */
export interface LeadTaskCreatedResp {
  taskId: string
  status: TaskStatus
}

/** 发现列表查询参数（03 §3.3） */
export interface LeadListReq {
  valueLevel?: 'high' | 'medium' | 'low' | 'all'
  keyword?: string
  country?: string
  industry?: string
  minMatchPct?: number
  taskId?: string
  inCrm?: boolean
  page?: number
  pageSize?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
}

/** 发现客户行（03 §1.6） */
export interface LeadItem {
  leadId: string
  companyName: string
  country: string
  industry?: string
  matchPct: number
  scoreLevel: 'high' | 'medium' | 'low'
  inCrm: boolean
  /** Insight Schema（03 §4：评分可解释，纯数字不给） */
  matchReasons?: Insight<number>
  website?: string
}

/** GET /leads/summary 响应：各价值档数量 */
export interface LeadSummaryResp {
  all: number
  high: number
  medium: number
  low: number
  inCrm: number
}

/** POST /leads/add-to-crm 请求（03 §3.4；ownerId 仅经理/管理员可指定他人） */
export interface AddToCrmReq {
  leadIds: string[]
  ownerId?: string
}

/** POST /leads/add-to-crm 响应（03 §3.4 v0.2 去重口径） */
export interface AddToCrmResp {
  created: number
  duplicated: number
  customers: { customerId: string; leadId: string }[]
  mapped: { leadId: string; mappedCustomerId: string }[]
}

/** GET /lead-hunter/summary 响应（03 §1.1） */
export interface LeadHunterSummary {
  employee: { employeeId: string; name: string; status: string; statusDetail?: string }
  todaySummary: { found: number; analyzed: number; highValue: number }
  currentTask: {
    taskId: string
    goal: string
    progressPct: number
    foundCount: number
    targetCount: number
    currentStep: string
    status: TaskStatus
  } | null
}
