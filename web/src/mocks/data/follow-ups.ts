import type {
  FollowUpExecution,
  FollowUpStrategy,
  FollowUpTaskItem,
  FollowUpTaskStatus,
} from '@/api/types/follow-up'

/**
 * 07 跟进 mock 内存态（07 接口文档；06 §5.3 mock 即契约）：
 * - 默认策略种子化（is_default，Day 0/3/7/14/30，07 §7）；自建策略可删（未被任务引用时）；
 * - 任务跨状态种子：ready/scheduled/waiting_approval/completed/paused；
 * - 执行记录含 skipped(customer_replied / frequency_capped) 留痕演示（07 §1.5）。
 */

const NOW = Date.now()
/** 相对当前时间生成 ISO（每次刷新种子时间滚动，Today/Tomorrow 展示稳定） */
function inHours(hoursAhead: number): string {
  return new Date(NOW + hoursAhead * 3_600_000).toISOString()
}

export const mockStrategies: FollowUpStrategy[] = [
  {
    strategyId: 'strat_1',
    name: '默认跟进策略',
    targetScope: { customerValue: ['high', 'medium', 'low'] },
    steps: [
      { seq: 1, dayOffset: 0, title: 'Initial Email', templateId: 'tpl_intro', channel: 'email' },
      { seq: 2, dayOffset: 3, title: 'Product Value', templateId: 'tpl_value', channel: 'email' },
      { seq: 3, dayOffset: 7, title: 'Product Case', templateId: 'tpl_case', channel: 'email' },
      { seq: 4, dayOffset: 14, title: 'Customer Case', templateId: 'tpl_customer', channel: 'email' },
      {
        seq: 5,
        dayOffset: 30,
        title: 'Break-up Email',
        content: 'It seems our solution may not be a fit right now…',
        channel: 'email',
        isBreakup: true,
      },
    ],
    autoSendPolicy: 'value_based',
    enabled: true,
    isDefault: true,
    createdAt: '2026-08-01T02:00:00Z',
  },
  {
    strategyId: 'strat_2',
    name: '高价值客户重点培育',
    targetScope: { customerValue: ['high'], industry: ['Sports'] },
    steps: [
      { seq: 1, dayOffset: 0, title: 'Warm Intro', content: 'Hi {{customer_name}}…', channel: 'email' },
      { seq: 2, dayOffset: 5, title: 'Case Sharing', templateId: 'tpl_case', channel: 'email' },
    ],
    autoSendPolicy: 'manual_review',
    enabled: true,
    createdAt: '2026-08-20T02:00:00Z',
  },
]

export const mockFollowUpTasks: FollowUpTaskItem[] = [
  {
    followUpTaskId: 'ftask_1',
    customerId: 'cus_1',
    companyName: 'ABC Sports',
    currentStage: 'follow_up_2',
    nextRunAt: inHours(3),
    status: 'ready',
    strategyId: 'strat_1',
    strategyName: '默认跟进策略',
  },
  {
    followUpTaskId: 'ftask_2',
    customerId: 'cus_2',
    companyName: 'Running Pro',
    currentStage: 'follow_up_1',
    nextRunAt: inHours(30),
    status: 'scheduled',
    strategyId: 'strat_1',
    strategyName: '默认跟进策略',
  },
  {
    followUpTaskId: 'ftask_3',
    customerId: 'cus_3',
    companyName: 'Fit Brand',
    currentStage: 'quote_followup',
    nextRunAt: inHours(6),
    status: 'waiting_approval',
    strategyId: 'strat_2',
    strategyName: '高价值客户重点培育',
  },
  {
    followUpTaskId: 'ftask_4',
    customerId: 'cus_4',
    companyName: 'Nordic Gear',
    currentStage: 'follow_up_3',
    nextRunAt: inHours(52),
    status: 'scheduled',
    strategyId: 'strat_1',
    strategyName: '默认跟进策略',
  },
  {
    followUpTaskId: 'ftask_5',
    customerId: 'cus_5',
    companyName: 'Pacific Footwear',
    currentStage: 'follow_up_2',
    nextRunAt: inHours(-4),
    status: 'ready',
    strategyId: 'strat_1',
    strategyName: '默认跟进策略',
  },
  {
    followUpTaskId: 'ftask_6',
    customerId: 'cus_6',
    companyName: 'Alpine Trading',
    currentStage: 'follow_up_1',
    nextRunAt: inHours(5 * 24),
    status: 'paused',
    strategyId: 'strat_1',
    strategyName: '默认跟进策略',
  },
  {
    followUpTaskId: 'ftask_7',
    customerId: 'cus_7',
    companyName: 'London Run',
    currentStage: 'follow_up_3',
    nextRunAt: inHours(-72),
    status: 'completed',
    strategyId: 'strat_1',
    strategyName: '默认跟进策略',
  },
  {
    followUpTaskId: 'ftask_8',
    customerId: 'cus_8',
    companyName: 'Sunrise Sports',
    currentStage: 'follow_up_2',
    nextRunAt: inHours(27),
    status: 'waiting_approval',
    strategyId: 'strat_1',
    strategyName: '默认跟进策略',
  },
]

export const mockExecutions: FollowUpExecution[] = [
  {
    executionId: 'exec_1',
    followUpTaskId: 'ftask_7',
    stepTitle: 'Initial Email',
    sentAt: '2026-08-20T03:10:00Z',
    status: 'sent',
    content: 'Hi John, following up on our carbon fiber insole solution…',
  },
  {
    executionId: 'exec_2',
    followUpTaskId: 'ftask_7',
    stepTitle: 'Product Value',
    sentAt: '2026-08-23T03:10:00Z',
    status: 'approved',
    content: 'Key value points of carbon fiber insoles for running brands…',
    approvedBy: '李四',
  },
  {
    executionId: 'exec_3',
    followUpTaskId: 'ftask_7',
    stepTitle: 'Product Case',
    sentAt: '2026-08-27T03:10:00Z',
    status: 'skipped',
    skipReason: 'customer_replied',
  },
  {
    executionId: 'exec_4',
    followUpTaskId: 'ftask_5',
    stepTitle: 'Product Value',
    sentAt: '2026-09-06T01:30:00Z',
    status: 'skipped',
    skipReason: 'frequency_capped',
  },
  {
    executionId: 'exec_5',
    followUpTaskId: 'ftask_3',
    stepTitle: 'Warm Intro',
    sentAt: '2026-09-07T01:00:00Z',
    status: 'waiting_approval',
    content: 'Hi Fit Brand team, …',
  },
  {
    executionId: 'exec_6',
    followUpTaskId: 'ftask_1',
    stepTitle: 'Initial Email',
    sentAt: '2026-08-30T03:10:00Z',
    status: 'sent',
    content: 'Hi ABC Sports, …',
  },
]

/** 客户是否存在进行中（非 completed/paused）跟进任务（07 §3.5：每客户仅 1 个） */
export function hasOngoingTask(customerId: string): boolean {
  return mockFollowUpTasks.some(
    (t) => t.customerId === customerId && !isTerminalLike(t.status),
  )
}

function isTerminalLike(status: FollowUpTaskStatus): boolean {
  return status === 'completed' || status === 'paused'
}

/** 策略是否被未完结任务引用（删除约束：未引用方可删） */
export function isStrategyInUse(strategyId: string): boolean {
  return mockFollowUpTasks.some((t) => t.strategyId === strategyId && !isTerminalLike(t.status))
}

export function nextTaskId(): string {
  const max = Math.max(
    0,
    ...mockFollowUpTasks.map((t) => Number.parseInt(t.followUpTaskId.replace('ftask_', ''), 10) || 0),
  )
  return `ftask_${max + 1}`
}

export function nextStrategyId(): string {
  const max = Math.max(
    0,
    ...mockStrategies.map((s) => Number.parseInt(s.strategyId.replace('strat_', ''), 10) || 0),
  )
  return `strat_${max + 1}`
}

export function nextExecutionId(): string {
  const max = Math.max(
    0,
    ...mockExecutions.map((e) => Number.parseInt(e.executionId.replace('exec_', ''), 10) || 0),
  )
  return `exec_${max + 1}`
}
