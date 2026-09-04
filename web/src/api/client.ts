/**
 * axios 统一封装 + 全量 TypeScript 类型定义
 * 后端契约：统一响应 { code, message, data }，code === 0 表示成功；
 * 拦截器在 code !== 0 时弹出 ElMessage.error 并 reject，成功时直接返回 data。
 */
import axios, { AxiosError, type AxiosInstance, type AxiosResponse } from 'axios'
import { ElMessage } from 'element-plus'

/* ==================== 通用响应 ==================== */

export interface ApiEnvelope<T = unknown> {
  code: number
  message: string
  data: T
}

/* ==================== 产品档案 ==================== */

export interface Profile {
  id: number
  name: string
  /** 产品名称与说明 */
  product_desc: string
  /** 产品关键词（逗号分隔） */
  keywords: string
  /** 目标市场（逗号分隔） */
  markets: string
  /** 我方差异化优势（选填，用于开发信） */
  advantages: string
  created_at: string
}

/** 新建/更新档案的请求体 */
export type ProfilePayload = Pick<
  Profile,
  'name' | 'product_desc' | 'keywords' | 'markets' | 'advantages'
>

/* ==================== 线索 ==================== */

export type LeadStatus =
  | 'new' // 新发现
  | 'queued' // 排队
  | 'scraping' // 抓取中
  | 'analyzing' // 分析中
  | 'done' // 已完成
  | 'failed' // 失败
  | 'confirmed' // 已确认开发

export type LeadGrade = 'A' | 'B' | 'C' | 'D'

export interface Lead {
  id: number
  profile_id: number
  company_name: string
  domain: string
  source_url: string
  source_query: string
  status: LeadStatus
  /** 0-100，未分析/失败为 null */
  score: number | null
  grade: LeadGrade | null
  error: string | null
  /** 主营摘要（列表接口冗余返回，可能缺失） */
  main_business?: string | null
  /** 联系方式摘要（列表接口冗余返回，可能缺失） */
  contact?: string | null
  created_at: string
  updated_at: string
}

/* ==================== 分析报告 ==================== */

export type Level3 = 'high' | 'medium' | 'low'
export type ImporterLevel = 'strong' | 'weak' | 'none'

export interface ReportSource {
  page: string
  url: string
  fetched_at: string
}

export interface ScaleInfo {
  founded?: string | null
  employees?: string | null
  certifications?: string[] | null
}

/** 报告全量 JSON（LLM 输出，带证据与出处） */
export interface Report {
  company_summary: string
  /** 公司概况的证据（可能缺失，兼容字段） */
  company_summary_evidence?: string | null
  main_business: string
  main_business_evidence?: string | null
  product_lines: string[]
  market_coverage: string
  scale_info: ScaleInfo | null
  scale_evidence: string | null
  match: { level: Level3; evidence: string }
  importer: { level: ImporterLevel; evidence: string }
  market_fit: { level: Level3; evidence: string }
  /** 联系方式由规则抽取（非 LLM） */
  contact: { emails: string[]; persons: string[]; has_form: boolean }
  /** 未获取到的字段说明 */
  incomplete: string[]
  sources: ReportSource[]
}

/** GET /api/leads/:id 返回：线索详情 + 报告 */
export interface LeadDetail extends Lead {
  report: Report | null
}

/* ==================== 开发信 ==================== */

export type EmailLanguage = 'en' | 'de' | 'es' | 'fr' | 'zh'

export interface EmailDraft {
  id: number
  lead_id: number
  /** 标题候选（1~2 个） */
  subjects: string[]
  body: string
  word_count: number
  /** 后置校验产生的提示（垃圾词等） */
  warnings?: string[]
  created_at?: string
}

/* ==================== 搜索 ==================== */

export type SearchProvider = 'duckduckgo' | 'google_cse' | 'serpapi'

export interface SearchPayload {
  profileId: number
  keywords?: string
  markets?: string
  provider?: SearchProvider
}

/* ==================== 兼容性归一化工具 ==================== */

/**
 * 兼容列表接口返回 T[] 或 { leads: T[] } / { items: T[] } 等包裹结构
 */
export function normalizeList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[]
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    for (const key of ['leads', 'items', 'list', 'profiles', 'emails', 'results']) {
      if (Array.isArray(obj[key])) return obj[key] as T[]
    }
  }
  return []
}

/**
 * 兼容详情接口返回 { ...lead, report } 或 { lead, report } 两种结构
 */
export function normalizeLeadDetail(raw: LeadDetail & { lead?: Lead }): LeadDetail {
  if (raw && typeof raw === 'object' && 'lead' in raw && raw.lead) {
    return { ...raw.lead, report: raw.report ?? null }
  }
  return raw
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeEmail(raw: any, leadId: number): EmailDraft {
  const subjects: string[] =
    Array.isArray(raw?.subjects) && raw.subjects.length
      ? raw.subjects.map(String)
      : raw?.subject
        ? [String(raw.subject)]
        : []
  return {
    id: Number(raw?.id ?? raw?.email_id ?? 0),
    lead_id: Number(raw?.lead_id ?? leadId),
    subjects,
    body: String(raw?.body ?? ''),
    word_count: Number(raw?.word_count ?? 0),
    warnings: Array.isArray(raw?.warnings) ? raw.warnings.map(String) : [],
    created_at: raw?.created_at ? String(raw.created_at) : undefined
  }
}

/* ==================== 二期：订单跟单类型 ==================== */

export type OrderStatus = 'active' | 'closed' | 'cancelled'
export type DocType = 'pi' | 'invoice' | 'pl'
export type AnomalyType = 'due_soon' | 'overdue' | 'deposit_pending' | 'stalled'

/** 进度节点（与后端 NODE_LABELS 一致） */
export const ORDER_NODES: Array<{ value: string; label: string }> = [
  { value: 'created', label: '订单创建' },
  { value: 'order_confirmed', label: '订单确认' },
  { value: 'deposit_received', label: '定金到账' },
  { value: 'factory_ordered', label: '工厂下单' },
  { value: 'producing', label: '生产中' },
  { value: 'inspected', label: '验货完成' },
  { value: 'shipped', label: '出货' },
  { value: 'dispatched', label: '发运' },
  { value: 'balance_received', label: '收尾款' }
]
export function nodeLabel(node: string): string {
  return ORDER_NODES.find((n) => n.value === node)?.label ?? node
}

export const INCOTERMS_OPTIONS = ['EXW', 'FCA', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP', 'FAS', 'FOB', 'CFR', 'CIF']

export interface OrderPayload {
  order_no?: string
  customer_name?: string
  customer_email?: string
  order_date?: string
  delivery_date?: string
  incoterms?: string
  payment_terms?: string
  currency?: string
  total_amount?: number
  remarks?: string
}

export interface OrderItemPayload {
  name?: string
  model?: string
  qty?: number | null
  unit?: string
  unit_price?: number | null
}

export interface Order {
  id: number
  order_no: string
  customer_name: string
  customer_email: string
  order_date: string
  delivery_date: string
  incoterms: string
  payment_terms: string
  currency: string
  total_amount: number
  status: OrderStatus
  remarks: string
  source_type: string
  source_file_name: string
  created_at: string
  updated_at: string
}

export interface OrderItemT {
  id?: number
  name: string
  model: string
  qty: number
  unit: string
  unit_price: number
  amount: number
}

export interface OrderEventT {
  id: number
  order_id: number
  node: string
  event_date: string
  note: string
  created_at: string
}

export interface OrderDocMeta {
  id: number
  doc_type: DocType
  doc_no: string
  version: number
  overrides_json: string | null
  note: string
  created_at: string
}

export interface OrderMail {
  id: number
  order_id: number
  kind: 'progress' | 'chase' | 'custom'
  to_addr: string
  subject: string
  body: string
  status: 'draft' | 'sent' | 'failed'
  error: string | null
  sent_at: string | null
  created_at: string
}

/** GET /api/orders 列表行（含派生字段） */
export interface OrderRow extends Order {
  current_node: string
  days_left: number | null
  anomaly_types: AnomalyType[]
}

/** GET /api/orders/:id 详情聚合 */
export interface OrderDetail extends Order {
  items: OrderItemT[]
  events: OrderEventT[]
  docs: OrderDocMeta[]
  mails: OrderMail[]
  nodes: Record<string, string>
}

/** 解析结果（逐字段置信度） */
export interface ParsedItemT {
  name: string | null
  model: string | null
  qty: number | null
  unit: string | null
  unit_price: number | null
  amount: number | null
}

export interface ParsedOrderT {
  order_no: string | null
  customer_name: string | null
  customer_email: string | null
  order_date: string | null
  delivery_date: string | null
  incoterms: string | null
  payment_terms: string | null
  currency: string | null
  total_amount: number | null
  remarks: string | null
  items: ParsedItemT[]
  confidence: Record<string, number>
}

export interface OrderImportResult {
  importId: number
  parsed: ParsedOrderT
  lowFields: string[]
}

export interface OrderWithItems extends Order {
  items: OrderItemT[]
}

export interface Anomaly {
  type: AnomalyType
  level: 'high' | 'medium' | 'low'
  order_id: number
  order_no: string
  customer_name: string
  delivery_date: string
  currency: string
  total_amount: number
  message: string
}

export interface DocOverride {
  seller_name?: string
  buyer_address?: string
  consignee?: string
  marks?: string
  cartons?: string
  gross_weight?: string
  net_weight?: string
  volume?: string
  remarks?: string
}

export interface DocResult {
  id: number
  doc_no: string
  version: number
  html_url: string
}

export interface SmtpPayload {
  host: string
  port: number
  secure: boolean
  user: string
  sender_name: string
  /** 仅写入，后端不下发 */
  pass?: string
}

export interface ReminderRulesPayload {
  days_before: number[]
  deposit_days: number
  stalled_days: number
}

export interface SettingsData {
  smtp: (Omit<SmtpPayload, 'pass'> & { has_password: boolean }) | null
  reminder_rules: ReminderRulesPayload
}

/* ==================== axios 实例与拦截器 ==================== */

const client: AxiosInstance = axios.create({
  baseURL: '',
  timeout: 180000 // AI 生成（搜索/分析/开发信）耗时较长
})

client.interceptors.response.use(
  (resp: AxiosResponse) => {
    const body = resp.data as ApiEnvelope | undefined
    // 兼容未包裹统一结构的响应（如文件流）
    if (!body || typeof body.code !== 'number') return resp
    if (body.code !== 0) {
      const msg = body.message || `请求失败（code=${body.code}）`
      ElMessage.error(msg)
      return Promise.reject(new Error(msg))
    }
    // 成功时直接返回业务数据 data，调用方无需再解包
    return body.data as unknown as AxiosResponse
  },
  (error: AxiosError<ApiEnvelope>) => {
    const msg = error.response?.data?.message || error.message || '网络请求失败'
    ElMessage.error(msg)
    return Promise.reject(error)
  }
)

/* ==================== API 方法 ==================== */

export const api = {
  /* ---- 产品档案 ---- */
  async listProfiles(): Promise<Profile[]> {
    return normalizeList<Profile>(await client.get<Profile[], Profile[]>('/api/profiles'))
  },
  async createProfile(payload: ProfilePayload): Promise<Profile> {
    return client.post<Profile, Profile>('/api/profiles', payload)
  },
  async updateProfile(id: number, payload: ProfilePayload): Promise<Profile> {
    return client.put<Profile, Profile>(`/api/profiles/${id}`, payload)
  },
  async deleteProfile(id: number): Promise<void> {
    await client.delete(`/api/profiles/${id}`)
  },

  /* ---- 搜索与导入 ---- */
  /** POST /api/search：搜索并入库 leads(status=new)，返回候选列表 */
  async search(payload: SearchPayload): Promise<Lead[]> {
    return normalizeList<Lead>(await client.post<unknown, unknown>('/api/search', payload))
  },
  /** POST /api/leads/import：粘贴导入（公司名或 URL，逐行），返回入库结果 */
  async importLeads(profileId: number, items: string[]): Promise<unknown> {
    return client.post<unknown, unknown>('/api/leads/import', { profileId, items })
  },

  /* ---- 线索 ---- */
  /** GET /api/leads?profileId&status：列表（含 score/grade/主营摘要/联系方式） */
  async listLeads(params?: { profileId?: number; status?: string }): Promise<Lead[]> {
    return normalizeList<Lead>(await client.get<unknown, unknown>('/api/leads', { params }))
  },
  /** GET /api/leads/:id：详情（含 report） */
  async getLead(id: number | string): Promise<LeadDetail> {
    return normalizeLeadDetail(
      await client.get<LeadDetail & { lead?: Lead }, LeadDetail & { lead?: Lead }>(
        `/api/leads/${id}`
      )
    )
  },
  /** POST /api/leads/analyze：入队批量分析 */
  async analyze(ids: number[]): Promise<void> {
    await client.post('/api/leads/analyze', { ids })
  },
  /** POST /api/leads/:id/retry：失败重试 / 重新分析 */
  async retry(id: number): Promise<void> {
    await client.post(`/api/leads/${id}/retry`)
  },
  /** POST /api/leads/:id/confirm：确认开发（status→confirmed） */
  async confirm(id: number): Promise<void> {
    await client.post(`/api/leads/${id}/confirm`)
  },

  /* ---- 开发信 ---- */
  /** POST /api/leads/:id/email：生成开发信（language 默认 en） */
  async generateEmail(id: number, language: EmailLanguage = 'en'): Promise<EmailDraft> {
    return normalizeEmail(
      await client.post<unknown, unknown>(`/api/leads/${id}/email`, { language }),
      id
    )
  },
  /** GET /api/leads/:id/emails：历史开发信 */
  async listEmails(id: number): Promise<EmailDraft[]> {
    return normalizeList<unknown>(await client.get<unknown, unknown>(`/api/leads/${id}/emails`)).map(
      (e) => normalizeEmail(e, id)
    )
  },

  /* ==================== 二期：订单跟单（order-followup） ==================== */

  /* ---- 类型 ---- */
  // (类型定义见下方 Order 命名空间)

  /* ---- 导入与建单 ---- */
  /** POST /api/orders/import：上传文件(base64)或粘贴文本 → AI 解析（暂存，不建单） */
  async importOrder(payload: { fileName?: string; contentBase64?: string; text?: string }): Promise<OrderImportResult> {
    return client.post<OrderImportResult, OrderImportResult>('/api/orders/import', payload)
  },
  /** POST /api/orders：确认建单（importId 可选） */
  async createOrder(payload: { importId?: number; order: OrderPayload; items: OrderItemPayload[] }): Promise<OrderWithItems> {
    return client.post('/api/orders', payload)
  },
  /** PUT /api/orders/:id：编辑订单与产品行 */
  async updateOrder(id: number, payload: { order: OrderPayload; items: OrderItemPayload[] }): Promise<OrderWithItems> {
    return client.put(`/api/orders/${id}`, payload)
  },
  /** POST /api/orders/:id/status：关闭/取消/恢复 */
  async setOrderStatus(id: number, status: 'active' | 'closed' | 'cancelled'): Promise<void> {
    await client.post(`/api/orders/${id}/status`, { status })
  },

  /* ---- 订单查询 ---- */
  /** GET /api/orders：台账列表（含当前节点/剩余天数/异常标记） */
  async listOrders(params?: { status?: string }): Promise<OrderRow[]> {
    return normalizeList<OrderRow>(await client.get('/api/orders', { params }))
  },
  /** GET /api/orders/:id：详情聚合 */
  async getOrder(id: number | string): Promise<OrderDetail> {
    return client.get(`/api/orders/${id}`)
  },
  /** POST /api/orders/:id/events：更新进度节点 */
  async addOrderEvent(id: number, payload: { node: string; event_date?: string; note?: string }): Promise<OrderEventT[]> {
    return client.post(`/api/orders/${id}/events`, payload)
  },

  /* ---- 单证 ---- */
  /** POST /api/orders/:id/docs：生成单证（确定性模板+校验） */
  async generateDoc(id: number, payload: { doc_type: DocType; overrides?: DocOverride; note?: string }): Promise<DocResult> {
    return client.post(`/api/orders/${id}/docs`, payload)
  },
  /** 单证 HTML 预览地址（新窗口打开，浏览器打印存 PDF） */
  docHtmlUrl(docId: number): string {
    return `/api/docs/${docId}/html`
  },

  /* ---- 异常看板 ---- */
  async listAnomalies(): Promise<Anomaly[]> {
    return normalizeList<Anomaly>(await client.get('/api/anomalies'))
  },

  /* ---- 邮件 ---- */
  /** POST /api/orders/:id/mail：AI 生成邮件草稿 */
  async generateMailDraft(id: number, payload: { kind: 'progress' | 'chase' | 'custom'; to?: string; tone?: 'gentle' | 'formal'; language?: string; extraNote?: string; anomalyMessage?: string }): Promise<OrderMail> {
    return client.post(`/api/orders/${id}/mail`, payload)
  },
  /** PUT /api/mails/:id：编辑草稿 */
  async updateMail(id: number, payload: { subject: string; body: string }): Promise<OrderMail> {
    return client.put(`/api/mails/${id}`, payload)
  },
  /** POST /api/mails/:id/send：确认发送（SMTP） */
  async sendMail(id: number): Promise<{ message_id: string }> {
    return client.post(`/api/mails/${id}/send`)
  },

  /* ---- 设置 ---- */
  async getSettings(): Promise<SettingsData> {
    return client.get('/api/settings')
  },
  async saveSettings(payload: { smtp?: SmtpPayload; reminder_rules?: ReminderRulesPayload }): Promise<void> {
    await client.put('/api/settings', payload)
  },
  async testSmtp(): Promise<void> {
    await client.post('/api/settings/smtp/test')
  }
}
