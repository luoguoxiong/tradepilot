import type { InsightCitation, InsightReason } from '@/api/types/insight'
import type { LeadItem } from '@/api/types/leads'
import type {
  ContactItem,
  ConversationItem,
  Customer360Insight,
  Customer360NextAction,
  Customer360Profile,
  CustomerOverview,
  CustomerProductItem,
  ProductMatchRow,
} from '@/api/types/customers'

import { mockLeads, mockTasks, registerTimedTask } from './business'
import { findCustomer, findCustomerByName, mockActivities, mockContacts } from './customers'

/**
 * M4-3 客户 360° mock 内存态（04 接口文档 §1/§3；06 §5.3 mock 即契约）：
 * - 双数据源：CRM 客户（mockCustomers）+ 获客池 lead 预览（mockLeads，inCrm=false）；
 *   inCrm=true 的 lead 按公司名命中已有客户（05 §7 同库口径）→ 归并为客户档案；
 * - Overview/评分/标签种子（S360）、AI 洞察种子、lead 联系人（lcon_*）、会话、产品资料；
 * - POST /customers/{id}/analyze 走 registerTimedTask 引擎，落终态回调写洞察 +
 *   scope=full 精化联系人决策影响力（04 §3.3）。
 */

// ===== 基础工具 =====

const NOW = Date.now()
function ago(minutesAgo: number): string {
  return new Date(NOW - minutesAgo * 60_000).toISOString()
}

interface EntityRef {
  kind: 'customer' | 'lead'
  /** 规范 key：customer = customerId；lead = leadId */
  key: string
}

/**
 * 解析 360 入口 id（/customers/:id 可传 customerId 或 leadId）。
 * inCrm=true 的 lead → 按公司名命中客户档案（打开即完整客户 360）。
 */
export function resolve360Entity(raw: string): EntityRef | undefined {
  if (findCustomer(raw)) return { kind: 'customer', key: raw }
  const lead = mockLeads.find((l) => l.leadId === raw)
  if (!lead) return undefined
  if (lead.inCrm) {
    const mapped = findCustomerByName(lead.companyName)
    if (mapped) return { kind: 'customer', key: mapped.customerId }
  }
  return { kind: 'lead', key: lead.leadId }
}

export function isLeadEntity(raw: string): boolean {
  const ref = resolve360Entity(raw)
  return ref?.kind === 'lead'
}

// ===== Stored360（score / tags / overview）种子与运行时覆盖 =====

interface Stored360 {
  score?: number
  industryTags?: string[]
  overview: CustomerOverview
}

const S360: Record<string, Stored360> = {
  // 05 示例客户
  cus_1: {
    score: 92,
    industryTags: ['Running', 'Sports', 'Brand'],
    overview: {
      companySize: '500+',
      foundedYear: 2008,
      customerType: 'brand',
      mainProducts: ['Running Shoes', 'Sports'],
      productMatches: [
        {
          productId: 'prod_1',
          productName: 'Carbon Fiber Insoles',
          matchPct: 92,
          reasons: [
            {
              text: '官网在售跑鞋配件线，与本司碳纤维鞋垫直接重合',
              evidence: 'abcsports.com 产品页',
              source: 'web_crawl',
            },
          ],
        },
        {
          productId: 'prod_2',
          productName: 'Running Insoles',
          matchPct: 85,
          reasons: [
            {
              text: '跑鞋主品类下存在功能性鞋垫需求',
              evidence: '行业知识库分类命中',
              source: 'knowledge_rag',
            },
          ],
        },
      ],
    },
  },
  cus_2: {
    score: 82,
    industryTags: ['Running', 'Sports'],
    overview: {
      companySize: '50-200',
      foundedYear: 2011,
      customerType: 'distributor',
      mainProducts: ['Running Gear'],
      productMatches: [
        {
          productId: 'prod_2',
          productName: 'Running Insoles',
          matchPct: 85,
          reasons: [{ text: '分销组合含足部配件线', evidence: '官网品类页', source: 'web_crawl' }],
        },
        {
          productId: 'prod_3',
          productName: 'Outdoor Insoles',
          matchPct: 64,
          reasons: [
            {
              text: '另有越野跑线，户外鞋垫存在潜在需求',
              evidence: '官网在售线',
              source: 'web_crawl',
            },
          ],
        },
      ],
    },
  },
  cus_3: {
    score: 71,
    industryTags: ['Outdoor', 'Sportswear'],
    overview: {
      companySize: '200-500',
      foundedYear: 2015,
      customerType: 'factory',
      mainProducts: ['Sportswear OEM'],
      productMatches: [
        {
          productId: 'prod_4',
          productName: 'Cycling Insoles',
          matchPct: 62,
          reasons: [{ text: 'OEM 线含运动护具代工', evidence: '工厂产能页', source: 'web_crawl' }],
        },
      ],
    },
  },
  cus_4: {
    score: 55,
    industryTags: ['Sports', 'Brand'],
    overview: {
      companySize: '50-200',
      foundedYear: 2019,
      customerType: 'brand',
      mainProducts: ['Fitness Apparel'],
      productMatches: [
        {
          productId: 'prod_2',
          productName: 'Running Insoles',
          matchPct: 68,
          reasons: [
            {
              text: '主推健身/运动品类，鞋垫可作为配件补充',
              evidence: '知识库信号',
              source: 'knowledge_rag',
            },
          ],
        },
      ],
    },
  },
  cus_8: {
    score: 52,
    industryTags: ['Trading'],
    overview: {
      companySize: '11-50',
      customerType: 'distributor',
      mainProducts: ['Sports Trading'],
      productMatches: [],
    },
  },
  // 获客池 lead 转 CRM（inCrm=true，映射客户）
  cus_lead_3: {
    score: 86,
    industryTags: ['Running', 'Sports'],
    overview: {
      companySize: '11-50',
      foundedYear: 2017,
      customerType: 'other',
      mainProducts: ['Running Club Retail'],
      productMatches: [
        {
          productId: 'prod_1',
          productName: 'Carbon Fiber Insoles',
          matchPct: 86,
          reasons: [
            {
              text: '有碳纤维鞋垫采购历史（RFQ 记录）',
              evidence: '历史询盘',
              source: 'knowledge_rag',
            },
          ],
        },
      ],
    },
  },
  cus_lead_7: {
    score: 66,
    industryTags: ['Import'],
    overview: {
      companySize: '50-200',
      customerType: 'distributor',
      mainProducts: ['Sports Protection'],
      productMatches: [],
    },
  },
  cus_lead_12: {
    score: 35,
    industryTags: ['Footwear'],
    overview: {
      companySize: '500+',
      customerType: 'factory',
      mainProducts: ['Shoes OEM'],
      productMatches: [
        {
          productId: 'prod_1',
          productName: 'Carbon Fiber Insoles',
          matchPct: 35,
          reasons: [
            {
              text: '鞋类代工厂，主营 OEM，与目标画像偏离',
              evidence: '公司画像',
              source: 'web_crawl',
            },
          ],
        },
      ],
    },
  },
}

/** 已入库客户 / 已精化评分（分析任务落地点），lead 走运行时派生 */
const liveScore = new Map<string, number>()

/** lead 运行时派生：标签 + 匹配产品（评分即 matchPct，与发现列表口径一致） */
function deriveLeadOverview(lead: LeadItem): Stored360 {
  const matches: ProductMatchRow[] = []
  if (lead.matchPct >= 45) {
    matches.push({
      productId: 'prod_1',
      productName: 'Carbon Fiber Insoles',
      matchPct: lead.matchPct,
      reasons: lead.matchReasons?.reasons?.length
        ? lead.matchReasons.reasons
        : [
            {
              text: `产品匹配：${lead.industry ?? '目标行业'}与官网在售线存在交集`,
              evidence: '官网交叉验证',
              source: 'web_crawl',
            },
          ],
    })
  }
  return {
    score: lead.matchPct,
    industryTags: lead.industry ? [lead.industry] : [],
    overview: { productMatches: matches },
  }
}

function storedOf(ref: EntityRef): Stored360 {
  if (ref.kind === 'customer') {
    const s = S360[ref.key]
    if (s) {
      const score = liveScore.get(ref.key) ?? s.score
      return score === undefined ? s : { ...s, score }
    }
    const item = findCustomer(ref.key)
    return {
      industryTags: item?.industry ? [item.industry] : [],
      overview: { productMatches: [] },
    }
  }
  const lead = mockLeads.find((l) => l.leadId === ref.key)
  return lead ? deriveLeadOverview(lead) : { industryTags: [], overview: { productMatches: [] } }
}

// ===== Profile 构建（GET /customers/{id}，04 §3.1）=====

export function build360Profile(raw: string): Customer360Profile | undefined {
  const ref = resolve360Entity(raw)
  if (!ref) return undefined
  if (ref.kind === 'customer') {
    const item = findCustomer(ref.key)
    if (!item) return undefined
    const s = storedOf(ref)
    return {
      customerId: item.customerId,
      companyName: item.companyName,
      score: s.score,
      country: item.country,
      website: item.website ?? undefined,
      industryTags: s.industryTags ?? [],
      inCrm: true,
      stage: item.stage,
      customerType: item.customerType ?? null,
      ownerId: item.ownerId,
      ownerName: item.ownerName,
      isFormal: item.isFormal,
      deleteLocked: item.deleteLocked,
      remark: item.remark ?? undefined,
      overview: s.overview,
    }
  }
  const lead = mockLeads.find((l) => l.leadId === ref.key)
  if (!lead) return undefined
  const s = storedOf(ref)
  return {
    customerId: lead.leadId,
    companyName: lead.companyName,
    score: s.score,
    country: lead.country,
    website: lead.website,
    industryTags: s.industryTags ?? [],
    inCrm: false,
    overview: s.overview,
  }
}

// ===== 产品资料（08 P1 前静态种子；D7 行点击抽屉数据源）=====

interface ProductMeta {
  category: string
  summary: string
  highlights: string[]
  sourceDocs: InsightCitation[]
}

const PRODUCT_META: Record<string, ProductMeta> = {
  prod_1: {
    category: '鞋垫 · 碳纤维',
    summary: '碳纤维支撑鞋垫：轻质高弹，适合竞速跑鞋与高强度训练鞋类升级。',
    highlights: ['全掌碳纤维板', '适配主流跑鞋楦', 'MOQ 2,000 双'],
    sourceDocs: [
      { docId: 'doc_1', docName: 'Carbon Fiber Catalog.pdf', chunkId: 'chk_12' },
      { docId: 'doc_2', docName: 'ABC Sports - Company Profile.pdf', chunkId: 'chk_3' },
    ],
  },
  prod_2: {
    category: '鞋垫 · 缓震',
    summary: '多密度缓震跑步鞋垫，覆盖日常训练与马拉松场景。',
    highlights: ['前掌回弹', '足弓支撑', '多密度注塑'],
    sourceDocs: [{ docId: 'doc_1', docName: 'Carbon Fiber Catalog.pdf', chunkId: 'chk_88' }],
  },
  prod_3: {
    category: '鞋垫 · 户外',
    summary: '户外/越野专用鞋垫，防滑透气、排水快干。',
    highlights: ['防泼水处理', '碎石路面防滑', '透气网布'],
    sourceDocs: [],
  },
  prod_4: {
    category: '鞋垫 · 骑行',
    summary: '骑行锁鞋内垫，长时踩踏支撑。',
    highlights: ['足弓支撑', '透气', '适配主流锁鞋'],
    sourceDocs: [],
  },
}

export function enrichProducts(matches: ProductMatchRow[]): CustomerProductItem[] {
  return matches.map((m) => {
    const meta = PRODUCT_META[m.productId]
    return meta
      ? {
          ...m,
          category: meta.category,
          summary: meta.summary,
          highlights: meta.highlights,
          sourceDocs: meta.sourceDocs,
        }
      : { ...m }
  })
}

// ===== 洞察种子 + 运行时（GET /customers/{id}/insights）=====

const S_INSIGHT: Record<string, Customer360Insight> = {
  cus_1: {
    purchaseProbability: {
      value: 92,
      confidence: 0.88,
      generatedAt: ago(6 * 60),
      reasons: [
        {
          text: '产品高度匹配',
          evidence: '在售跑鞋配件线与本司碳纤维鞋垫重合',
          source: 'web_crawl',
        },
        { text: '公司规模符合目标', evidence: '员工 500+，区域头部零售商', source: 'web_crawl' },
        { text: '近期有主动询盘动作', evidence: '样本询盘与官网访问回升', source: 'knowledge_rag' },
      ],
      citations: [
        { docId: 'doc_1', docName: 'Carbon Fiber Catalog.pdf', chunkId: 'chk_12' },
        { docId: 'doc_2', docName: 'ABC Sports - Company Profile.pdf', chunkId: 'chk_3' },
      ],
    },
    nextAction: { type: 'contact_decision_maker', label: '联系采购负责人 →', targetId: 'con_1' },
  },
  cus_2: {
    purchaseProbability: {
      value: 78,
      confidence: 0.75,
      generatedAt: ago(26 * 60),
      reasons: [
        { text: '分销商具备足部配件采购习惯', evidence: '分销组合含配件线', source: 'web_crawl' },
        { text: '跟进中且回复积极', evidence: '最近一次跟进收到意向', source: 'knowledge_rag' },
      ],
    },
    nextAction: { type: 'generate_outreach', label: '发送开发信给采购 →', targetId: 'con_3' },
  },
  cus_4: {
    purchaseProbability: {
      value: 55,
      confidence: 0.62,
      estimated: true,
      generatedAt: ago(10 * 24 * 60),
      reasons: [
        {
          text: '历史询盘记录显示曾对产品线感兴趣',
          evidence: '近 90 天官网访问与询盘活跃度回升',
          source: 'web_crawl',
        },
        {
          text: '行业知识库出现 3 条正向信号',
          evidence: '目标市场行情回暖',
          source: 'knowledge_rag',
        },
      ],
      citations: [{ docId: 'doc_1', docName: 'Carbon Fiber Catalog.pdf', chunkId: 'chk_12' }],
    },
    nextAction: { type: 'generate_outreach', label: 'AI 建议重新激活 → 开发信', targetId: 'con_4' },
  },
}

const liveInsight = new Map<string, Customer360Insight>()

export function get360Insight(raw: string): Customer360Insight {
  const ref = resolve360Entity(raw)
  const key = ref?.key ?? raw
  return liveInsight.get(key) ?? S_INSIGHT[key] ?? { purchaseProbability: null, nextAction: null }
}

/** 进行中的分析任务（raw 入口 → taskId）；Insights 面板据此展示进度并轮询到终态 */
export const runningAnalyze = new Map<string, string>()

export function analyze360(raw: string, scope: 'overview' | 'full'): string {
  const ref = resolve360Entity(raw)!
  const companyName =
    ref.kind === 'customer'
      ? (findCustomer(ref.key)?.companyName ?? raw)
      : (mockLeads.find((l) => l.leadId === ref.key)?.companyName ?? raw)
  const prev = runningAnalyze.get(raw)
  if (prev && mockTasksHas(prev)) return prev

  const task = registerTimedTask({
    title: `AI 分析 ${companyName}`,
    goal: `对 ${companyName} 生成采购概率洞察${scope === 'full' ? '并精化联系人决策影响力' : ''}`,
    durationMs: 7000,
    onComplete: () => {
      runningAnalyze.delete(raw)
      liveInsight.set(ref.key, composeInsight(ref))
      if (scope === 'full') refineContactInfluence(ref)
    },
  })
  runningAnalyze.set(raw, task.taskId)
  return task.taskId
}

function mockTasksHas(taskId: string): boolean {
  return mockTasks.has(taskId)
}

/** 组合分析洞察：依据存储概览/匹配证据确定性生成（杜绝未知 key 与虚构来源） */
function composeInsight(ref: EntityRef): Customer360Insight {
  const s = storedOf(ref)
  const matches = s.overview.productMatches ?? []
  const reasons: InsightReason[] = []
  const citations: InsightCitation[] = []

  for (const m of matches.slice(0, 3)) {
    for (const r of m.reasons ?? []) {
      reasons.push({ text: r.text, evidence: r.evidence, source: r.source })
    }
    const meta = PRODUCT_META[m.productId]
    if (meta) for (const c of meta.sourceDocs) citations.push(c)
  }
  if (s.overview.companySize) {
    reasons.push({
      text: '公司规模符合目标画像',
      evidence: `员工 ${s.overview.companySize}`,
      source: 'web_crawl',
    })
  }
  if (reasons.length === 0) {
    reasons.push({
      text: '官网与公开渠道可见度正常',
      evidence: '交叉验证未发现明显风险信号',
      source: 'web_crawl',
    })
  }
  const avg = matches.length
    ? Math.round(matches.reduce((sum, m) => sum + m.matchPct, 0) / matches.length)
    : 0
  const value = Math.min(96, Math.max(35, avg || (s.score ?? 70)))

  const primary = firstContact(ref)
  const nextAction: Customer360NextAction | null =
    ref.kind === 'customer' || primary
      ? { type: 'contact_decision_maker', label: '联系采购负责人 →', targetId: primary?.contactId }
      : null

  return {
    purchaseProbability: {
      value,
      confidence: value >= 80 ? 0.86 : value >= 55 ? 0.72 : 0.6,
      generatedAt: new Date().toISOString(),
      reasons: reasons.slice(0, 4),
      ...(citations.length ? { citations: citations.slice(0, 3) } : {}),
    },
    nextAction,
  }
}

/** 该实体的首个可联系联系人（主/首位） */
function firstContact(ref: EntityRef): ContactItem | null {
  return entityContacts(ref)[0] ?? null
}

// ===== 联系人（04 §1.4；客户走 mockContacts，lead 走 lcon_* 种子）=====

const leadContacts: ContactItem[] = [
  lcon('lcon_1', 'Mike Chen', 'Purchasing Manager', 'mike@abcsports.com', 'lead_1', 90, true),
  lcon('lcon_2', 'Sarah Lee', 'Head of Buying', 'sarah@abcsports.com', 'lead_1', 75),
  lcon('lcon_3', 'Anna Weber', 'Head of Purchasing', 'anna@northpeak.de', 'lead_2', 90, true),
  lcon('lcon_4', 'Julie Martin', 'Buyer', 'julie@marathongear.fr', 'lead_4', 75, true),
  lcon('lcon_5', 'Chris Park', 'Procurement Manager', 'chris@pacific.com.au', 'lead_5', 75, true),
  lcon('lcon_6', 'Tom Becker', 'Founder & CEO', 'tom@maple.ca', 'lead_8', 40, true),
]

function lcon(
  id: string,
  name: string,
  title: string,
  email: string,
  leadId: string,
  influence: number | null,
  primary = false,
): ContactItem {
  return {
    contactId: id,
    name,
    title,
    email,
    customerId: leadId,
    companyName: mockLeads.find((l) => l.leadId === leadId)?.companyName ?? '',
    decisionInfluencePct: influence,
    isPrimary: primary,
  }
}

export function find360Contact(contactId: string): ContactItem | null {
  return (
    mockContacts.find((c) => c.contactId === contactId) ??
    leadContacts.find((c) => c.contactId === contactId) ??
    null
  )
}

function entityContacts(ref: EntityRef): ContactItem[] {
  return ref.kind === 'customer'
    ? mockContacts.filter((c) => c.customerId === ref.key)
    : leadContacts.filter((c) => c.customerId === ref.key)
}

export function customer360ContactsPage(raw: string, keyword = '', page = 1, pageSize = 20) {
  const ref = resolve360Entity(raw)
  if (!ref) return { list: [] as ContactItem[], total: 0, page, pageSize }
  const kw = keyword.toLowerCase()
  let items = entityContacts(ref)
  if (kw) {
    items = items.filter(
      (c) =>
        c.name.toLowerCase().includes(kw) ||
        c.title?.toLowerCase().includes(kw) ||
        c.email.toLowerCase().includes(kw),
    )
  }
  return {
    list: items.slice((page - 1) * pageSize, page * pageSize),
    total: items.length,
    page,
    pageSize,
  }
}

/** scope=full 完成：为已有规则基线的联系人补 AI 精化证据链（confidence<0.5 场景保留基线值） */
function refineContactInfluence(ref: EntityRef) {
  const contacts = entityContacts(ref)
  for (const contact of contacts) {
    if (contact.decisionInfluencePct === null || contact.decisionInfluencePct === undefined)
      continue
    contact.decisionInfluenceReasons = [
      {
        text: '职衔处于采购职能决策层，规则基线命中',
        evidence: contact.title ?? contact.name,
        source: 'web_crawl',
      },
      {
        text: 'AI 精化：职位名称与官网组织页交叉验证一致',
        evidence: '官网 / 公开渠道',
        source: 'knowledge_rag',
      },
    ]
  }
}

// ===== 产品列表（04 §1.5 Products，行点击抽屉 D7）=====

export function customer360Products(raw: string): CustomerProductItem[] {
  const ref = resolve360Entity(raw)
  if (!ref) return []
  return enrichProducts(storedOf(ref).overview.productMatches ?? [])
}

// ===== 会话（04 §1.5 Conversations，复用 06；P0 行内预览）=====

const mockConversations: ConversationItem[] = [
  {
    conversationId: 'conv_1',
    email: 'sales@abcsports.com',
    subject: 'Re: 样品参数与最小起订量确认',
    lastMessageAt: ago(2 * 60),
    unreadCount: 2,
    lastSnippet: '请提供碳纤维鞋垫 MOQ 与打样周期，我们计划进入内部评审。',
  },
  {
    conversationId: 'conv_2',
    email: 'sarah@abcsports.com',
    subject: '年度框架：价格阶梯与交期',
    lastMessageAt: ago(3 * 24 * 60),
    unreadCount: 0,
    lastSnippet: '若 12 月前锁定年度量，可接受阶梯报价。',
  },
  {
    conversationId: 'conv_3',
    email: 'tom@runningpro.com',
    subject: 'Re: Follow-up #2 样品索取',
    lastMessageAt: ago(26 * 60),
    unreadCount: 1,
    lastSnippet: '可以安排两款样品，地址信息稍后同步。',
  },
  {
    conversationId: 'conv_4',
    email: 'info@sportfactory.de',
    subject: 'OEM 产能询盘',
    lastMessageAt: ago(2 * 24 * 60),
    unreadCount: 0,
    lastSnippet: '贵司是否承接运动配件 OEM 打样？',
  },
]

/** 会话 → 所属客户（CRM 会话全部挂在已入库客户下，与 mockContacts 邮箱/公司口径一致） */
const CONV_OWNER: Record<string, string> = {
  conv_1: 'cus_1',
  conv_2: 'cus_1',
  conv_3: 'cus_2',
  conv_4: 'cus_3',
}

function entityConversations(ref: EntityRef): ConversationItem[] {
  return ref.kind === 'customer'
    ? mockConversations.filter((c) => CONV_OWNER[c.conversationId] === ref.key)
    : []
}

export function customer360Conversations(raw: string, page = 1, pageSize = 20) {
  const ref = resolve360Entity(raw)
  if (!ref) return { list: [] as ConversationItem[], total: 0, page, pageSize }
  const items = entityConversations(ref)
  return {
    list: items.slice((page - 1) * pageSize, page * pageSize),
    total: items.length,
    page,
    pageSize,
  }
}

// ===== 活动（04 §1.5 Activities，与 /activities 全局时间线同口径）=====

export function customer360Activities(raw: string, type?: string, page = 1, pageSize = 20) {
  const ref = resolve360Entity(raw)
  if (!ref || ref.kind === 'lead')
    return { list: [] as typeof mockActivities, total: 0, page, pageSize }
  let items = [...mockActivities].filter((a) => a.customerId === ref.key)
  if (type) items = items.filter((a) => a.type === type)
  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  return {
    list: items.slice((page - 1) * pageSize, page * pageSize),
    total: items.length,
    page,
    pageSize,
  }
}

// ===== AI 生成开发信（04 §3.4：产出草稿，不发送）=====

export function createOutreachDraft(
  contactId: string,
  scenario: 'cold_outreach' | 'quote_followup',
): { draftId: string; conversationId?: string; content: string } {
  const contact = find360Contact(contactId)
  const companyName = contact?.companyName ?? '贵司'
  const ref = contact ? resolve360Entity(contact.customerId) : undefined
  const match = ref ? (storedOf(ref).overview.productMatches ?? [])[0] : undefined
  const productLine = match?.productName ?? '运动鞋垫产品线'
  const greeting = contact?.title ? `Hi ${contact.name.split(' ')[0]},` : `Hi ${companyName} team,`

  const body =
    scenario === 'cold_outreach'
      ? [
          `我们注意到 ${companyName} 在${contact?.title ? `${contact.title} 的职责范围内` : '业务上'}关注${productLine}相关产品。`,
          '我们是一家专注功能性鞋垫的制造工厂，支持 OEM/ODM，可为贵司提供样品与参数表。',
          '如方便，是否可以约 15 分钟简单沟通一下贵司的选品与采购计划？',
        ]
      : [
          `跟进之前报价：${companyName} 对 ${productLine} 的意向我们已同步内部。`,
          '如贵司已确认需求范围，我可补充阶梯价与交期表，方便内部评审。',
        ]

  return {
    draftId: `draft_${Date.now()}`,
    conversationId: contact ? `conv_${contact.customerId}` : undefined,
    content: [
      `To: ${contact?.email ?? ''}`,
      `Subject: ${scenario === 'cold_outreach' ? 'Re: Product line introduction' : 'Re: Quote follow-up'}`,
      '',
      greeting,
      ...body.map((line) => `\n${line}`),
      '\n\nBest regards,',
      'TradePilot Sales Team',
    ].join('\n'),
  }
}
