/**
 * 07-AI自动跟进（接口文档 07 v0.2.1）：
 * 任务总览/任务列表/策略 CRUD/apply 应用/执行记录。
 */

/** 跟进任务状态（07 §1.2 followUpTaskStatus） */
export type FollowUpTaskStatus = 'ready' | 'scheduled' | 'waiting_approval' | 'completed' | 'paused'

/** 跟进阶段（07 §1.2） */
export type FollowUpStage = 'follow_up_1' | 'follow_up_2' | 'follow_up_3' | 'quote_followup'

/** 自动发送策略（07 §1.4） */
export type AutoSendPolicy = 'manual_review' | 'auto_send' | 'value_based'

/** 任务总览统计（07 §3.1） */
export interface FollowUpSummary {
  executingCount: number
  tabs: { all: number; today: number; waitingApproval: number; completed: number }
}

/** 跟进任务行（07 §1.2/§3.2） */
export interface FollowUpTaskItem {
  followUpTaskId: string
  customerId: string
  companyName: string
  currentStage: FollowUpStage
  /** UTC 存储，展示按企业时区换算（07 §4） */
  nextRunAt: string
  status: FollowUpTaskStatus
  strategyId: string
  strategyName: string
}

/** 任务列表查询（07 §3.2：tab/keyword/分页） */
export interface FollowUpTaskQuery {
  tab?: 'all' | 'today' | 'waiting_approval' | 'completed'
  keyword?: string
  page?: number
  pageSize?: number
}

/** 策略步骤（ER 05 §2.5：templateId | content 二选一，channel MVP 固定 email） */
export interface StrategyStep {
  seq: number
  dayOffset: number
  title: string
  templateId?: string
  content?: string
  channel: 'email'
  /** Break-up 节点系统置位并强制 manual_review（07 §4/§2.1 设计说明 4） */
  isBreakup?: boolean
}

/** 适用范围（07 §1.4 targetScope；MVP 仅作标注与筛选，自动挂载 P1） */
export interface StrategyTargetScope {
  customerValue: Array<'high' | 'medium' | 'low'>
  industry?: string[]
  tags?: string[]
}

/** 跟进策略（07 §1.3/§1.4 + ER 05 §2.4） */
export interface FollowUpStrategy {
  strategyId: string
  name: string
  targetScope: StrategyTargetScope
  steps: StrategyStep[]
  autoSendPolicy: AutoSendPolicy
  enabled: boolean
  /** 默认策略：种子数据不可删、可复制后编辑（07 §7） */
  isDefault?: boolean
  createdAt?: string
}

/** 策略时间线节点状态（07 §1.3：done ✓ / running ⏳ / pending ○） */
export type StrategyStepRunStatus = 'done' | 'running' | 'pending'

/** 策略时间线（07 §1.3）：策略 + 各步骤对当前客户视角的执行状态 */
export interface StrategyTimeline {
  strategyId: string
  name: string
  steps: Array<{
    day: number
    title: string
    status: StrategyStepRunStatus
    isBreakup?: boolean
  }>
}

/** 新建/编辑策略请求（07 §3.3） */
export interface UpsertStrategyReq {
  name: string
  targetScope: StrategyTargetScope
  steps: StrategyStep[]
  autoSendPolicy: AutoSendPolicy
  enabled: boolean
}

/** 执行记录状态（07 §1.5） */
export type ExecutionStatus = 'sent' | 'waiting_approval' | 'approved' | 'rejected' | 'failed' | 'skipped'

/** 跳过原因（07 §1.5：customer_replied 客户回复自动暂停 / frequency_capped 频控顺延留痕） */
export type SkipReason = 'customer_replied' | 'frequency_capped'

/** 执行记录行（07 §1.5/§3.4） */
export interface FollowUpExecution {
  executionId: string
  followUpTaskId: string
  stepTitle: string
  sentAt: string
  status: ExecutionStatus
  content?: string
  approvedBy?: string
  skipReason?: SkipReason
}

/** apply 应用策略请求（07 §3.5） */
export interface ApplyStrategyReq {
  customerIds: string[]
}

/** apply 响应：created / skipped（task_exists = 每客户仅 1 个进行中任务） */
export interface ApplyStrategyResp {
  created: Array<{ customerId: string; followUpTaskId: string }>
  skipped: Array<{ customerId: string; reason: 'task_exists' }>
}
