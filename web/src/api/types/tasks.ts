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

/** 任务产出物（14 §1.2） */
export interface TaskOutput {
  type: 'leads' | 'report' | 'draft' | 'insight'
  payload: unknown
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
  steps?: { name: string; status: string; startedAt?: string; finishedAt?: string }[]
  outputs?: TaskOutput[] | null
  targetCount?: number
  foundCount?: number
  error?: string
  linkedApprovalId?: string
  createdAt?: string
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
