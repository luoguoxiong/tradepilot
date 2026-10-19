/**
 * 统一任务模型（14-AI任务中心接口文档）。
 * 03/11/13/08 等异步操作复用本组接口；接口范围 P0 = detail/logs/stream/steps/retry。
 */

/** 任务状态（14 §1.1） */
export type TaskStatus =
  'running' | 'waiting_approval' | 'scheduled' | 'completed' | 'failed' | 'paused' | 'canceled'

/** 任务类型（14 §1.1） */
export type TaskType =
  | 'lead_hunting'
  | 'email_reply'
  | 'follow_up'
  | 'order_monitor'
  | 'business_analysis'
  | 'knowledge_index'
  | 'product_analysis'
  | 'product_knowledge'

/** 任务列表行（14 §1.1） */
export interface TaskItem {
  taskId: string
  title: string
  employeeId: string
  employeeName: string
  role: string
  type: TaskType
  status: TaskStatus
  progressPct: number
  createdAt?: string
  startedAt?: string
  finishedAt?: string
  error?: string
  linkedApprovalId?: string
}

/** 执行日志（03 §1.5 / 14 §3.3） */
export interface TaskLog {
  logId: string
  time: string
  /** search/found/crawl/match/contact/lookup/error（03 §1.5） */
  type: string
  content: string
  /** 关联发现的客户（可点击） */
  leadId?: string
}

/** 任务产出物（14 §1.2）；handoff 为转人工交接摘要（P1-X-31，append 语义） */
export interface TaskOutput {
  type: 'leads' | 'report' | 'draft' | 'insight' | 'handoff'
  payload: unknown
}

/** 任务执行步骤（14 §1.2；status 复用 taskStatus 枚举） */
export interface TaskStep {
  seq?: number
  name: string
  status: TaskStatus
  startedAt?: string | null
  finishedAt?: string | null
}

/** 任务详情（14 §1.2，进度卡 + 抽屉数据源） */
export interface TaskDetail {
  taskId: string
  title: string
  status: TaskStatus
  progressPct: number
  currentStep?: string
  type: TaskType
  employeeId?: string
  employeeName?: string
  goal?: string
  input?: unknown
  steps?: TaskStep[]
  outputs?: TaskOutput[] | null
  targetCount?: number
  foundCount?: number
  error?: string
  linkedApprovalId?: string
  retryOf?: string | null
  createdAt?: string
  startedAt?: string | null
  finishedAt?: string | null
}

/** logs 增量响应（14 §3.3） */
export interface TaskLogsResp {
  items: TaskLog[]
  hasMore: boolean
}

/** SSE 事件体（14 §3.4） */
export interface TaskProgressEvent {
  progressPct: number
  currentStep: string
  foundCount?: number
  targetCount?: number
}

export interface TaskStatusEvent {
  status: TaskStatus
  linkedApprovalId?: string
}

export interface TaskDoneEvent {
  status: TaskStatus
  outputs?: TaskOutput[] | null
  error?: string
}

/** POST /tasks/{id}/retry 响应 */
export interface TaskRetryResp {
  taskId: string
  status: 'running' | 'scheduled'
}

/** 状态 Tab（14 FR-01）：all = 全部，其余为单状态精确筛选 */
export type TaskTab = 'all' | 'running' | 'waiting_approval' | 'completed' | 'failed'

/** 任务列表查询（14 §3.1；status 由 Tab 下发，all 时不传） */
export interface TaskListReq {
  status?: TaskStatus
  employeeId?: string
  type?: TaskType
  keyword?: string
  page?: number
  pageSize?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
}

/** POST /tasks 通用新建（14 §3.2，`+ 新任务` 统一入口） */
export interface CreateTaskReq {
  employeeId: string
  type: TaskType
  title: string
  input?: Record<string, unknown>
  /** 定时触发（UTC ISO；缺省即时/排队） */
  scheduledAt?: string
}

/** POST /tasks 响应（14 §3.2：running 已即时投递 / scheduled 排队或定时） */
export interface CreateTaskResp {
  taskId: string
  status: 'running' | 'scheduled'
}

/** pause / cancel 响应（14 §3.6） */
export interface TaskOpResp {
  taskId: string
  status: TaskStatus
}

/** resume 响应（14 §3.6）：fromCheckpoint 标记是否从检查点续跑 */
export interface TaskResumeResp {
  taskId: string
  status: TaskStatus
  fromCheckpoint: boolean
}

/** POST /tasks/{id}/transfer-to-human 请求（14 §3.6，全部可选） */
export interface TransferToHumanReq {
  reason?: string
  assignee?: string
  summary?: string
}

/** 转人工交接摘要（outputs 中 type='handoff' 的 payload） */
export interface TaskHandoffPayload {
  fromStatus: string
  reason: string | null
  summary: string
  assignee: string | null
  transferredAt: string
  transferredBy: string
}

/** POST /tasks/{id}/transfer-to-human 响应 */
export interface TransferToHumanResp {
  taskId: string
  status: TaskStatus
  handoff: { type: 'handoff'; payload: TaskHandoffPayload }
}

/** POST /tasks/batch 失败批量处理（14 §3.7，P1-X-33） */
export interface BatchTaskActionReq {
  action: 'retry' | 'transfer_to_human'
  taskIds: string[]
  reason?: string
}

/** 批量逐条处理结果（单条失败不阻断其余） */
export interface BatchTaskItemResult {
  taskId: string
  ok: boolean
  status?: TaskStatus
  newTaskId?: string
  error?: string
}

export interface BatchTaskActionResp {
  action: string
  total: number
  succeeded: number
  failed: number
  results: BatchTaskItemResult[]
}
