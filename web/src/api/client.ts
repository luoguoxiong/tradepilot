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
  }
}
