import { nextId } from './db'
import type { LeadItem } from '@/api/types/leads'
import type {
  ActivityItem,
  ActivityType,
  ContactItem,
  CustomerDetail,
  CustomerNextAction,
  CustomerType,
} from '@/api/types/customers'
import type { CustomerStage } from '@/utils/enum-map'

/**
 * M4-2 CRM mock 内存态（05 接口文档 §1/§3；06 §5.3 mock 即契约）：
 * - 客户（潜在/正式）、联系人、活动为独立内存数组，handler 内直接增删改；
 * - 客户删除不直接删：置 delete_locked + 由 /approvals/summary 动态计数（12 §3.1）；
 * - 承接 03「加入 CRM」落库：lead 命中公司名 → 映射，否则 createCustomerFromLead 新建。
 */

const NOW = Date.now()
/** 相对当前时间生成 ISO（每次刷新种子时间滚动，相对时间展示稳定） */
function ago(minutesAgo: number): string {
  return new Date(NOW - minutesAgo * 60_000).toISOString()
}

const OWNER_NAMES: Record<string, string> = {
  'u-demo': '演示管理员',
  'm-1': '张三',
  'm-2': '李四',
  'm-3': '王五',
}

export function ownerNameOf(ownerId: string): string {
  return OWNER_NAMES[ownerId] ?? ownerId
}

function action(type: CustomerNextAction['type'], label: string): CustomerNextAction {
  return { type, label }
}

function customer(input: {
  id: string
  name: string
  country: string
  industry?: string
  type?: CustomerType
  formal: boolean
  stage: CustomerStage
  owner: string
  lastActivity?: number
  nextAction?: CustomerNextAction | null
  reactivate?: boolean
  locked?: boolean
  website?: string
  remark?: string
  createdAtDaysAgo?: number
}): CustomerDetail {
  const reactivateSuggestion = input.reactivate
    ? {
        value: 72,
        confidence: 0.68,
        reasons: [
          {
            text: '历史询盘记录显示曾对产品线感兴趣',
            evidence: '官网访问与询盘活跃度在近 90 天回升',
            source: 'web_crawl',
          },
          {
            text: '目标市场行情回暖，同类客户回复率上升',
            evidence: '行业知识库近月新增 3 条正向信号',
            source: 'knowledge_rag',
          },
        ],
        citations: [{ docId: 'doc_1', docName: 'Carbon Fiber Catalog.pdf', chunkId: 'chk_12' }],
        estimated: true,
        generatedAt: ago(10 * 24 * 60),
      }
    : null
  return {
    customerId: input.id,
    companyName: input.name,
    country: input.country,
    industry: input.industry,
    stage: input.stage,
    isFormal: input.formal,
    ownerId: input.owner,
    ownerName: ownerNameOf(input.owner),
    lastActivityAt: input.lastActivity !== undefined ? ago(input.lastActivity) : null,
    nextAction: input.nextAction ?? null,
    reactivateSuggestion,
    deleteLocked: input.locked ?? false,
    customerType: input.type ?? 'other',
    website: input.website,
    remark: input.remark,
    contactsCount: 0,
    createdAt: ago((input.createdAtDaysAgo ?? 60) * 24 * 60),
  }
}

/** 种子客户（含 05 PRD §2.1 示例行，便于 E2E/走查对齐） */
export const mockCustomers: CustomerDetail[] = [
  customer({
    id: 'cus_1',
    name: 'ABC Sports',
    country: 'US',
    industry: 'Sports',
    type: 'brand',
    formal: true,
    stage: 'negotiation',
    owner: 'u-demo',
    lastActivity: 2 * 60,
    nextAction: action('send_quote', '发送报价'),
    website: 'https://www.abcsports.com',
    remark: '美东区域头部零售商，重视交期稳定性',
    createdAtDaysAgo: 90,
  }),
  customer({
    id: 'cus_2',
    name: 'Running Pro',
    country: 'US',
    industry: 'Sports',
    type: 'distributor',
    formal: true,
    stage: 'contacted',
    owner: 'm-1',
    lastActivity: 1 * 24 * 60,
    nextAction: action('follow_up', 'Follow-up #2'),
    website: 'https://www.runningpro.com',
    createdAtDaysAgo: 75,
  }),
  customer({
    id: 'cus_3',
    name: 'Sport Factory',
    country: 'DE',
    industry: 'Outdoor',
    type: 'factory',
    formal: false,
    stage: 'new_lead',
    owner: 'u-demo',
    lastActivity: 2 * 24 * 60,
    nextAction: action('send_outreach', '发送开发信'),
    createdAtDaysAgo: 30,
  }),
  customer({
    id: 'cus_4',
    name: 'Fit Brand',
    country: 'UK',
    industry: 'Sports',
    type: 'brand',
    formal: false,
    stage: 'cold',
    owner: 'u-demo',
    lastActivity: 10 * 24 * 60,
    nextAction: action('reactivate_ai', 'AI 建议重新激活'),
    reactivate: true,
    website: 'https://www.fitbrand.co.uk',
    createdAtDaysAgo: 200,
  }),
  // 以下三个由 mockLeads（inCrm=true）映射而来：加入 CRM 落库口径（05 §7 问题 2/3）
  customer({
    id: 'cus_lead_3',
    name: 'London Run Co',
    country: 'UK',
    industry: 'Sports',
    type: 'other',
    formal: false,
    stage: 'contacted',
    owner: 'm-2',
    lastActivity: 1 * 24 * 60,
    nextAction: action('follow_up', 'Follow-up #1'),
    createdAtDaysAgo: 20,
  }),
  customer({
    id: 'cus_lead_7',
    name: 'Sunrise Imports',
    country: 'US',
    industry: 'Import',
    type: 'distributor',
    formal: false,
    stage: 'new_lead',
    owner: 'u-demo',
    lastActivity: 3 * 24 * 60,
    nextAction: action('send_outreach', '发送开发信'),
    createdAtDaysAgo: 12,
  }),
  customer({
    id: 'cus_lead_12',
    name: 'Kanto Shoes',
    country: 'JP',
    industry: 'Footwear',
    type: 'factory',
    formal: false,
    stage: 'new_lead',
    owner: 'm-1',
    lastActivity: 8 * 24 * 60,
    nextAction: null,
    createdAtDaysAgo: 9,
  }),
  // 删除待审锁定样例：Aurora Trading 已在删除审批中（/approvals/summary customer_delete 计数来源）
  customer({
    id: 'cus_8',
    name: 'Aurora Trading',
    country: 'DE',
    industry: 'Trading',
    type: 'distributor',
    formal: false,
    stage: 'contacted',
    owner: 'u-demo',
    lastActivity: 5 * 24 * 60,
    nextAction: action('follow_up', 'Follow-up #1'),
    locked: true,
    createdAtDaysAgo: 40,
  }),
]

/** 全量客户公司名（小写），「加入 CRM / 新建客户」去重口径（03 §3.4 / 05 §7） */
export const customerCompanyNames = new Set(mockCustomers.map((c) => c.companyName.toLowerCase()))

/** 删除待审锁定客户数 → 12 审批摘要 customer_delete 计数（审批拒绝后解锁） */
export function countDeleteLockedCustomers(): number {
  return mockCustomers.filter((c) => c.deleteLocked).length
}

export function findCustomer(customerId: string): CustomerDetail | undefined {
  return mockCustomers.find((c) => c.customerId === customerId)
}

/** 按公司名（忽略大小写）检索已有客户：03「加入 CRM」/ 新建去重映射（03 §3.4） */
export function findCustomerByName(companyName: string): CustomerDetail | undefined {
  const normalized = companyName.toLowerCase()
  return mockCustomers.find((c) => c.companyName.toLowerCase() === normalized)
}

export function nextCustomerId(): string {
  return nextId('cus')
}

/** 03 获客「加入 CRM」新建客户（负责人默认操作人，命中已有公司名时调用方做映射处理） */
export function createCustomerFromLead(item: LeadItem, ownerId: string): CustomerDetail {
  const detail = customer({
    id: `cus_${item.leadId}`,
    name: item.companyName,
    country: item.country,
    industry: item.industry,
    formal: false,
    stage: 'new_lead',
    owner: ownerId,
    lastActivity: 0,
    nextAction: action('send_outreach', '发送开发信'),
    website: item.website,
  })
  mockCustomers.push(detail)
  customerCompanyNames.add(detail.companyName.toLowerCase())
  return detail
}

// ===== 联系人（05 §1.3） =====

const contact = (
  id: string,
  name: string,
  title: string,
  email: string,
  customerId: string,
  influence: number | null,
  primary = false,
): ContactItem => ({
  contactId: id,
  name,
  title,
  email,
  customerId,
  companyName: mockCustomers.find((c) => c.customerId === customerId)?.companyName ?? '',
  decisionInfluencePct: influence,
  isPrimary: primary,
})

export const mockContacts: ContactItem[] = [
  contact('con_1', 'Mike Chen', 'Purchasing Manager', 'mike@abcsports.com', 'cus_1', 90, true),
  contact('con_2', 'Sarah Lee', 'CEO', 'sarah@abcsports.com', 'cus_1', 75),
  contact('con_3', 'Tom Becker', 'Founder & CEO', 'tom@runningpro.com', 'cus_2', 90, true),
  contact('con_4', 'Emma Clark', 'Head of Buying', 'emma@fitbrand.co.uk', 'cus_4', 75, true),
  contact('con_5', 'Oliver Grant', 'Buyer', 'oliver@londonrun.co.uk', 'cus_lead_3', 40, true),
  contact(
    'con_6',
    'Hiro Tanaka',
    'General Manager',
    'hiro@kantoshoes.jp',
    'cus_lead_12',
    null,
    true,
  ),
]

// ===== 活动（05 §1.3：全局时间线；与客户 360° 同数据口径） =====

const activity = (
  id: string,
  type: ActivityType,
  summary: string,
  customerId: string | null,
  operatorType: 'ai' | 'user',
  operatorName: string,
  minutesAgo: number,
  refType: string | null = null,
  refId: string | null = null,
): ActivityItem => ({
  activityId: id,
  type,
  summary,
  customerId,
  customerName: mockCustomers.find((c) => c.customerId === customerId)?.companyName ?? null,
  operatorType,
  operatorName,
  refType,
  refId,
  createdAt: ago(minutesAgo),
})

export const mockActivities: ActivityItem[] = [
  activity(
    'act_1',
    'stage_change',
    '客户阶段推进至「谈判中」',
    'cus_1',
    'user',
    '演示管理员',
    2 * 60,
  ),
  activity(
    'act_2',
    'email',
    '发送跟进邮件：样品参数与最小起订量确认',
    'cus_2',
    'user',
    '张三',
    1 * 24 * 60,
    'message',
    'msg_100',
  ),
  activity(
    'act_3',
    'owner_change',
    '负责人由「张三」改派为「李四」（团队转交）',
    'cus_lead_3',
    'user',
    '演示管理员',
    3 * 24 * 60,
  ),
  activity(
    'act_4',
    'follow_up',
    '执行跟进策略：Follow-up #1（未回复自动跟进）',
    'cus_lead_3',
    'ai',
    'Echo · 跟进员工',
    1 * 24 * 60,
    'follow_up_execution',
    'ftask_1',
  ),
  activity(
    'act_5',
    'note',
    '更新采购偏好：重视交期稳定性与验厂支持',
    'cus_1',
    'user',
    '张三',
    4 * 24 * 60,
  ),
  activity(
    'act_6',
    'ai_action',
    'AI 客户分析：识别到 2 条重新激活信号，生成建议',
    'cus_4',
    'ai',
    'Scout · 客户研究员',
    10 * 24 * 60,
  ),
  activity(
    'act_7',
    'email',
    '收到询盘回复：等待客户内部分析后确认样品',
    'cus_3',
    'ai',
    'Ace · 外贸销售员',
    2 * 24 * 60,
    'message',
    'msg_102',
  ),
]

export function pushActivity(entry: Omit<ActivityItem, 'activityId' | 'createdAt'>): ActivityItem {
  const item: ActivityItem = {
    ...entry,
    activityId: nextId('act'),
    createdAt: new Date().toISOString(),
  }
  mockActivities.unshift(item)
  return item
}
