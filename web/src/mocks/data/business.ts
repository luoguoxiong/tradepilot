import { nextId } from './db'
import type { EmployeeCard, RoleTemplate, SopParamDef } from '@/api/types/employees'
import type { InsightCitation } from '@/api/types/insight'
import type { LeadAdvancedSettings, LeadItem, LeadTaskParsed } from '@/api/types/leads'
import type { TaskStatus, TaskType } from '@/api/types/tasks'

/**
 * M3 业务 mock 数据（02 员工中心 / 03 获客 / 14 任务模型）。
 * 时间驱动任务引擎：创建任务时生成确定性脚本（logs/progress/done），
 * 所有查询按 elapsed 实时重放，SSE 流与轮询口径天然一致（06 §5.3 mock 即契约）。
 */

// ===== 员工 =====

export const mockEmployees: EmployeeCard[] = [
  {
    employeeId: 'emp_1',
    role: 'lead_hunter',
    name: 'Hunter · 获客员工',
    status: 'idle',
    statusDetail: '空闲中，随时可以开始寻找客户',
    todayStats: [],
    kpi: null,
    currentTask: null,
    workspacePath: '/lead-gen',
  },
  {
    employeeId: 'emp_2',
    role: 'customer_researcher',
    name: 'Scout · 客户研究员',
    status: 'idle',
    statusDetail: '空闲中',
    todayStats: [],
    kpi: null,
    currentTask: null,
    workspacePath: null,
  },
  {
    employeeId: 'emp_3',
    role: 'sales',
    name: 'Ace · 外贸销售员',
    status: 'idle',
    statusDetail: '空闲中',
    todayStats: [],
    kpi: null,
    currentTask: null,
    workspacePath: null,
  },
  {
    employeeId: 'emp_4',
    role: 'follow_up',
    name: 'Echo · 跟进员工',
    status: 'idle',
    statusDetail: '空闲中',
    todayStats: [],
    kpi: null,
    currentTask: null,
    workspacePath: null,
  },
  // D4 口径：跟单员工 P0 固定 idle + 占位说明（02 §1.2 v0.3）
  {
    employeeId: 'emp_5',
    role: 'merchandiser',
    name: 'Trace · 跟单员工',
    status: 'idle',
    statusDetail: '即将上线，随订单中心（P1）启用',
    todayStats: [],
    kpi: null,
    currentTask: null,
    workspacePath: null,
  },
  // D4 口径：外贸经理卡片置灰占位（00 §5.1 D4）
  {
    employeeId: 'emp_6',
    role: 'manager',
    name: 'Chief · 外贸经理',
    status: 'idle',
    statusDetail: '即将上线，随外贸经理模块（P1）启用',
    todayStats: [],
    kpi: null,
    currentTask: null,
    workspacePath: null,
  },
]

const SOP_MATCH_PRODUCT: SopParamDef = {
  key: 'match_product',
  label: '产品匹配分档阈值',
  type: 'select',
  options: [
    { value: 'high', label: 'High（≥ 85 分）' },
    { value: 'medium', label: 'Medium（≥ 60 分）' },
    { value: 'low', label: 'Low（宽松）' },
  ],
  defaultValue: 'high',
}

export const mockRoleTemplates: RoleTemplate[] = [
  {
    role: 'lead_hunter',
    name: 'Hunter · 获客员工',
    goal: '按目标市场持续寻找高匹配潜客并产出结构化线索',
    sopTemplateId: 'sop-lead-hunter-v1',
    sopParams: { match_product: 'high' },
    sopParamDefs: [SOP_MATCH_PRODUCT],
    skills: ['市场检索', '官网解析', '产品匹配', '联系人发现'],
    tools: ['web_search', 'site_crawl', 'crm_write'],
    knowledgeScope: ['产品资料', '行业知识'],
    memoryConfig: { retentionDays: 180, scope: 'org' },
    kpiConfig: { metric: 'daily_leads', target: 35, period: 'daily' },
  },
  {
    role: 'customer_researcher',
    name: 'Scout · 客户研究员',
    goal: '对客户做深度背调并产出 AI 洞察',
    sopTemplateId: 'sop-researcher-v1',
    sopParams: {},
    sopParamDefs: [],
    skills: ['背景调查', '舆情分析', '供应链分析'],
    tools: ['web_search', 'site_crawl'],
    knowledgeScope: ['行业知识'],
    memoryConfig: { retentionDays: 180, scope: 'org' },
    kpiConfig: { metric: 'daily_profiles', target: 20, period: 'daily' },
  },
  {
    role: 'sales',
    name: 'Ace · 外贸销售员',
    goal: '按会话语境生成高回复率邮件草稿',
    sopTemplateId: 'sop-sales-v1',
    sopParams: {},
    sopParamDefs: [],
    skills: ['询盘回复', '跟进话术', '多语言写作'],
    tools: ['email_send', 'web_search'],
    knowledgeScope: ['产品资料', '常见问答'],
    memoryConfig: { retentionDays: 180, scope: 'org' },
    kpiConfig: { metric: 'daily_replies', target: 30, period: 'daily' },
  },
  {
    role: 'follow_up',
    name: 'Echo · 跟进员工',
    goal: '按策略节奏自动跟进客户直至转化或关闭',
    sopTemplateId: 'sop-follow-up-v1',
    sopParams: {},
    sopParamDefs: [],
    skills: ['节奏跟进', '价值分层'],
    tools: ['email_send', 'crm_write'],
    knowledgeScope: ['常见问答'],
    memoryConfig: { retentionDays: 180, scope: 'org' },
    kpiConfig: { metric: 'daily_followups', target: 40, period: 'daily' },
  },
  {
    role: 'merchandiser',
    name: 'Trace · 跟单员工',
    goal: '监控订单进度并预警延期风险（P1）',
    sopTemplateId: 'sop-merchandiser-v1',
    sopParams: {},
    sopParamDefs: [],
    skills: ['订单跟踪'],
    tools: [],
    knowledgeScope: [],
    memoryConfig: { retentionDays: 180, scope: 'org' },
    kpiConfig: { metric: 'active_orders', target: 10, period: 'daily' },
  },
  {
    role: 'manager',
    name: 'Chief · 外贸经理',
    goal: '生成每日经营报告与关键决策建议（P1）',
    sopTemplateId: 'sop-manager-v1',
    sopParams: {},
    sopParamDefs: [],
    skills: ['数据分析'],
    tools: [],
    knowledgeScope: [],
    memoryConfig: { retentionDays: 180, scope: 'org' },
    kpiConfig: { metric: 'daily_reports', target: 1, period: 'daily' },
  },
]

// ===== 发现客户 =====

function lead(
  id: string,
  companyName: string,
  country: string,
  industry: string,
  matchPct: number,
  scoreLevel: 'high' | 'medium' | 'low',
  inCrm: boolean,
  reasonText: string,
  citations?: InsightCitation[],
): LeadItem {
  return {
    leadId: id,
    companyName,
    country,
    industry,
    matchPct,
    scoreLevel,
    inCrm,
    website: `https://www.${companyName.toLowerCase().replace(/[^a-z]/g, '')}.com`,
    matchReasons: {
      value: matchPct,
      confidence: Math.min(0.95, matchPct / 100),
      reasons: [
        {
          text: reasonText,
          evidence: `官网与公开渠道交叉验证（${industry}）`,
          source: 'web_crawl',
        },
      ],
      // M4-1：知识库引用样例（引用解析数据见 mocks/data/knowledge.ts）
      ...(citations?.length ? { citations } : {}),
      generatedAt: '2026-09-06T08:00:00Z',
    },
  }
}

export const mockLeads: LeadItem[] = [
  lead('lead_1', 'ABC Sports', 'US', 'Sports', 92, 'high', false, '产品高度匹配：在售跑鞋配件线', [
    { docId: 'doc_1', docName: 'Carbon Fiber Catalog.pdf', chunkId: 'chk_12' },
    { docId: 'doc_1', docName: 'Carbon Fiber Catalog.pdf', chunkId: 'chk_88' },
    { docId: 'doc_2', docName: 'ABC Sports - Company Profile.pdf', chunkId: 'chk_3' },
  ]),
  lead(
    'lead_2',
    'NorthPeak Outdoor',
    'DE',
    'Outdoor',
    88,
    'high',
    false,
    '官网主推登山/越野品类，匹配碳纤维鞋垫',
  ),
  lead(
    'lead_3',
    'London Run Co',
    'UK',
    'Sports',
    86,
    'high',
    true,
    '有碳纤维鞋垫采购历史',
    // 软删文档引用样例：doc_3 已删，展示「已删除」禁跳转（11 §3.5 留痕回溯）
    [{ docId: 'doc_3', docName: 'London Run RFQ History.pdf', chunkId: 'chk_5' }],
  ),
  lead('lead_4', 'Marathon Gear FR', 'FR', 'Sports', 84, 'high', false, '跑鞋品牌，SKU 覆盖中高端'),
  lead('lead_5', 'Pacific Footwear', 'AU', 'Footwear', 72, 'medium', false, '鞋类分销商，规模匹配'),
  lead('lead_6', 'Rhein Trade GmbH', 'DE', 'Trading', 68, 'medium', false, '体育用品贸易商'),
  lead('lead_7', 'Sunrise Imports', 'US', 'Import', 66, 'medium', true, '进口商，主营运动护具'),
  lead('lead_8', 'Maple Sports Inc', 'CA', 'Sports', 63, 'medium', false, '运动品牌经销商'),
  lead('lead_9', 'Iberia Running', 'ES', 'Sports', 61, 'medium', false, '跑步俱乐部周边零售'),
  lead('lead_10', 'Nordic Gear', 'SE', 'Outdoor', 45, 'low', false, '户外综合零售，匹配度一般'),
  lead('lead_11', 'Sahara Trading', 'AE', 'Trading', 38, 'low', false, '综合贸易，无明确产品线'),
  lead('lead_12', 'Kanto Shoes', 'JP', 'Footwear', 35, 'low', true, '鞋类代工厂，非目标客户画像'),
]

// ===== 任务引擎（时间驱动确定性脚本）=====

type ScriptEvent = {
  atMs: number
  event: 'log' | 'progress' | 'done'
  data: Record<string, unknown>
}

export interface MockTask {
  taskId: string
  title: string
  employeeId: string
  employeeName: string
  role: string
  type: TaskType
  status: TaskStatus
  createdAt: string
  /** 演示用运行起点（epoch ms） */
  startedAt: number
  goal: string
  parsed: LeadTaskParsed
  advancedSettings?: LeadAdvancedSettings
  targetCount: number
  script: ScriptEvent[]
  durationMs: number
  /** 完成时注入的线索种子 */
  foundLeads: (() => LeadItem)[]
  completed: boolean
  completedAt: number | null
  outputs: { type: string; payload: unknown }[] | null
  error?: string
  /** 落终态回调（AI 分析等跨模块产出写入；由 syncTasks 在 completed 时触发） */
  onComplete?: () => void
}

export const mockTasks = new Map<string, MockTask>()
/** 员工排队中的任务（单员工并发 = 1，14 §3.2） */
const queuedByEmployee = new Map<string, string[]>()

const LEAD_POOL: [string, string, string, 'high' | 'medium' | 'low'][] = [
  ['Everest Athletics', 'US', 'Sports', 'high'],
  ['Alpine Step AG', 'DE', 'Footwear', 'high'],
  ['Gold Coast Runners', 'AU', 'Sports', 'medium'],
  ['Ontario Sportswear', 'CA', 'Sports', 'medium'],
  ['Lyon Footwear SARL', 'FR', 'Footwear', 'medium'],
  ['Danish Active ApS', 'DK', 'Sports', 'low'],
  ['Osaka Trading KK', 'JP', 'Trading', 'low'],
]

/** 生成获客任务执行脚本：约 22s，20 条日志 + 6 次进度 + done */
function buildLeadHuntScript(task: Omit<MockTask, 'script' | 'durationMs'>): {
  script: ScriptEvent[]
  durationMs: number
} {
  const script: ScriptEvent[] = []
  let at = 800
  let found = 0
  const pushLog = (type: string, content: string, leadId?: string) => {
    script.push({
      atMs: at,
      event: 'log',
      data: { logId: nextId('log'), time: '', type, content, ...(leadId ? { leadId } : {}) },
    })
    at += 900 + Math.round(Math.random() * 500)
  }
  const pushProgress = (progressPct: number, currentStep: string) => {
    script.push({
      atMs: at,
      event: 'progress',
      data: { progressPct, currentStep, foundCount: found, targetCount: task.targetCount },
    })
  }

  pushLog('search', `🔍 检索市场：${task.parsed.targetMarket} · ${task.parsed.customerType}`)
  pushProgress(5, '搜索潜在公司')
  pushLog('search', `🔍 检索关键词："${task.parsed.targetProduct}" distributors`)
  pushLog('found', `✓ 发现公司：Everest Athletics（US）`)
  found = 1
  pushProgress(14, '分析公司官网')

  const companies = [
    ['Everest Athletics', 'high'],
    ['Alpine Step AG', 'high'],
    ['Gold Coast Runners', 'medium'],
    ['Ontario Sportswear', 'medium'],
    ['Lyon Footwear SARL', 'medium'],
    ['Danish Active ApS', 'low'],
    ['Osaka Trading KK', 'low'],
  ] as const

  companies.forEach(([name, level], index) => {
    const leadId = `lead_new_${index + 1}`
    pushLog('crawl', `🌐 读取官网 ${name.toLowerCase().replace(/[^a-z]/g, '')}.com`)
    const pct = level === 'high' ? 88 + index : level === 'medium' ? 65 + index : 40 + index
    pushLog('match', `🧠 产品匹配度：${pct}%（${task.parsed.targetProduct}）`, leadId)
    if (level !== 'low') {
      pushLog('contact', `👤 发现联系人：Purchasing Manager @ ${name}`)
      pushLog('lookup', `📩 查找联系方式：官网公开邮箱`)
    }
    found = index + 1
    if (index % 2 === 1) {
      pushProgress(14 + Math.round(((index + 1) / companies.length) * 82), '分析公司官网')
    }
  })

  at += 400
  pushProgress(100, '完成')
  script.push({
    atMs: at,
    event: 'done',
    data: {
      status: 'completed',
      outputs: [{ type: 'leads', payload: { count: companies.length } }],
    },
  })

  return { script, durationMs: at + 300 }
}

export function createLeadHuntTask(input: {
  goalText: string
  parsed: LeadTaskParsed
  advancedSettings?: LeadAdvancedSettings
  targetCount?: number
  employeeId?: string
  /** 是否在完成时注入线索种子（batch-analyze 等非获客任务为 false） */
  seedLeads?: boolean
}): MockTask {
  const employee =
    mockEmployees.find((e) => e.employeeId === (input.employeeId ?? 'emp_1')) ?? mockEmployees[0]
  const targetCount = input.targetCount ?? 35

  const task: MockTask = {
    taskId: nextId('task'),
    title: input.goalText.slice(0, 24) || '获客任务',
    employeeId: employee.employeeId,
    employeeName: employee.name,
    role: employee.role,
    type: 'lead_hunting',
    status: 'running',
    createdAt: new Date().toISOString(),
    startedAt: Date.now(),
    goal: input.goalText,
    parsed: input.parsed,
    advancedSettings: input.advancedSettings ?? {
      matchThresholds: { high: 85, medium: 60 },
      jobTitles: ['Purchasing Manager', 'Buyer'],
      excludeDomains: [],
    },
    targetCount,
    script: [],
    durationMs: 0,
    foundLeads:
      input.seedLeads === false
        ? []
        : LEAD_POOL.map(
            ([name, country, industry, level]) =>
              () =>
                lead(
                  nextId('lead'),
                  name,
                  country,
                  industry,
                  level === 'high'
                    ? 90 + Math.round(Math.random() * 6)
                    : level === 'medium'
                      ? 62 + Math.round(Math.random() * 18)
                      : 35 + Math.round(Math.random() * 20),
                  level,
                  false,
                  `产品匹配：${input.parsed.targetProduct} 与官网在售线重合`,
                ),
          ),
    completed: false,
    completedAt: null,
    outputs: null,
  }

  const { script, durationMs } = buildLeadHuntScript(task)
  task.script = script
  task.durationMs = durationMs

  // 单员工并发 = 1：已有 running 任务则排队（scheduled FIFO）
  const runningExists = [...mockTasks.values()].some(
    (t) => t.employeeId === employee.employeeId && !t.completed && t.status === 'running',
  )
  if (runningExists) {
    task.status = 'scheduled'
    task.startedAt = 0
    const queue = queuedByEmployee.get(employee.employeeId) ?? []
    queue.push(task.taskId)
    queuedByEmployee.set(employee.employeeId, queue)
  }

  mockTasks.set(task.taskId, task)
  return task
}

/** 时间推进：到期任务落终态 + 注入线索 + 队首出队（所有任务类 handler 入口调用） */
export function syncTasks() {
  const now = Date.now()
  for (const task of mockTasks.values()) {
    if (!task.completed && task.status === 'running' && now >= task.startedAt + task.durationMs) {
      task.completed = true
      task.completedAt = now
      task.status = 'completed'
      task.outputs =
        (task.script.find((e) => e.event === 'done')?.data.outputs as MockTask['outputs']) ?? null
      for (const makeLead of task.foundLeads) mockLeads.unshift(makeLead())
      // 跨模块产出回调（AI 分析写洞察等）在落终态后同步执行，随后续查询自然可见
      task.onComplete?.()
    }
  }
  // 队首出队
  for (const [employeeId, queue] of queuedByEmployee) {
    if (queue.length === 0) continue
    const running = [...mockTasks.values()].some(
      (t) => t.employeeId === employeeId && !t.completed && t.status === 'running',
    )
    if (!running) {
      const nextId0 = queue.shift()
      if (nextId0) {
        const next = mockTasks.get(nextId0)
        if (next) {
          next.status = 'running'
          next.startedAt = Date.now()
        }
      }
    }
  }
}

/** 任务在当前时刻的实时快照（/tasks/{id}） */
export function taskSnapshot(task: MockTask) {
  syncTasks()
  const elapsed = task.completed ? task.durationMs : Math.max(0, Date.now() - task.startedAt)
  const lastProgress = [...task.script]
    .reverse()
    .find((e) => e.event === 'progress' && e.atMs <= elapsed)
  const done = task.completed
  return {
    taskId: task.taskId,
    title: task.title,
    status: task.status,
    type: task.type,
    employeeId: task.employeeId,
    employeeName: task.employeeName,
    progressPct: done ? 100 : ((lastProgress?.data.progressPct as number) ?? 0),
    currentStep: (lastProgress?.data.currentStep as string) ?? '排队等待中',
    foundCount: (lastProgress?.data.foundCount as number) ?? 0,
    targetCount: task.targetCount,
    goal: task.goal,
    input: { parsed: task.parsed, advancedSettings: task.advancedSettings },
    outputs: done ? task.outputs : null,
    error: task.error,
    createdAt: task.createdAt,
  }
}

/** 员工当前任务轻量对象（D5：02 currentTask） */
export function employeeCurrentTask(employeeId: string) {
  syncTasks()
  const task = [...mockTasks.values()]
    .filter((t) => t.employeeId === employeeId && !t.completed)
    .sort((a, b) => b.startedAt - a.startedAt)[0]
  if (!task) return null
  const snapshot = taskSnapshot(task)
  return {
    taskId: task.taskId,
    title: task.title,
    taskType: task.type,
    status: task.status,
    progressPct: snapshot.progressPct,
    currentStep: snapshot.currentStep,
  }
}

/** 刷新员工派生状态（卡片 status/KPI/todayStats） */
export function refreshEmployeeCards() {
  syncTasks()
  const highValue = mockLeads.filter((l) => l.scoreLevel === 'high').length
  for (const employee of mockEmployees) {
    if (employee.role === 'lead_hunter') {
      const current = employeeCurrentTask(employee.employeeId)
      employee.status = current
        ? current.status === 'waiting_approval'
          ? 'waiting_approval'
          : 'working'
        : 'idle'
      employee.statusDetail = current
        ? `正在执行：${current.title}`
        : '空闲中，随时可以开始寻找客户'
      employee.currentTask = current
      employee.todayStats = [{ label: '今日找到', count: mockLeads.length, unit: '个客户' }]
      employee.kpi = {
        metric: 'daily_leads',
        achieved: mockLeads.length,
        target: 35,
        progressPct: Math.min(100, Math.round((mockLeads.length / 35) * 100)),
        period: 'daily',
      }
    }
  }
  void highValue
}

/**
 * 注册通用确定性短任务（客户 360° AI 分析 / 批量精化等跨模块异步操作）：
 * - 脚本 = 若干日志 + 进度 + done，按 elapsed 实时重放（与获客任务同一引擎）；
 * - 不进入员工排队队列（分析型任务单条存在，SOP 并行策略由后端契约定义）；
 * - 落终态时 syncTasks 触发 onComplete 写入产出（洞察 / 决策影响力）。
 */
export function registerTimedTask(input: {
  title: string
  goal: string
  employeeId?: string
  /** 默认 customer_researcher（emp_2） */
  type?: TaskType
  durationMs?: number
  onComplete?: () => void
}): MockTask {
  const employee =
    mockEmployees.find((e) => e.employeeId === (input.employeeId ?? 'emp_2')) ?? mockEmployees[0]
  const durationMs = input.durationMs ?? 8000

  const script: ScriptEvent[] = []
  let at = 500
  const pushLog = (type: string, content: string) => {
    script.push({
      atMs: at,
      event: 'log',
      data: { logId: nextId('log'), time: '', type, content },
    })
    at += Math.round(durationMs / 6)
  }
  const pushProgress = (progressPct: number, currentStep: string) => {
    script.push({ atMs: at, event: 'progress', data: { progressPct, currentStep } })
  }

  pushLog('analyze', `🧠 读取客户资料与公开信息：${input.title}`)
  pushProgress(12, '收集背景信息')
  pushLog('crawl', '🌐 交叉验证官网 / 行业知识库')
  pushProgress(40, '核对产品匹配与公司规模')
  pushLog('match', '🧠 计算采购概率与证据链')
  pushProgress(75, '生成 AI 洞察')
  pushLog('done', '✓ 分析完成，洞察已写入客户档案')
  at += 400
  pushProgress(100, '完成')
  script.push({ atMs: durationMs, event: 'done', data: { outputs: null } })

  const task: MockTask = {
    taskId: nextId('task'),
    title: input.title,
    employeeId: employee.employeeId,
    employeeName: employee.name,
    role: employee.role,
    type: input.type ?? 'product_analysis',
    status: 'running',
    createdAt: new Date().toISOString(),
    startedAt: Date.now(),
    goal: input.goal,
    parsed: { targetMarket: '—', customerType: '—', targetProduct: '—' },
    advancedSettings: undefined,
    targetCount: 0,
    script,
    durationMs,
    foundLeads: [],
    completed: false,
    completedAt: null,
    outputs: null,
    onComplete: input.onComplete,
  }
  mockTasks.set(task.taskId, task)
  return task
}
