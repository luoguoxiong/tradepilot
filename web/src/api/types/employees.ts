/** AI 数字员工（02 接口文档）：卡片 / 角色模板 / 创建表单 */

export type EmployeeRole =
  'lead_hunter' | 'customer_researcher' | 'sales' | 'follow_up' | 'merchandiser' | 'manager'

/** 员工状态（02 §1.1，语义色）；跟单员工 P0 固定 idle */
export type EmployeeStatus = 'working' | 'idle' | 'waiting_approval' | 'error'

/** KPI 进度（02 §1.1）；metric 按角色枚举，period 固定 daily */
export interface EmployeeKpi {
  metric: string
  achieved: number
  target: number
  progressPct: number
  period: 'daily'
}

/** 当前执行任务轻量对象（02 §1.1 v0.2.1 / 00 §5.1 D5） */
export interface EmployeeCurrentTask {
  taskId: string
  title: string
  taskType: string
  status: string
  progressPct: number
  currentStep?: string
}

/** 员工卡片（02 §1.1） */
export interface EmployeeCard {
  employeeId: string
  role: EmployeeRole
  name: string
  avatar?: string
  status: EmployeeStatus
  statusDetail?: string
  todayStats: { label: string; count: number; unit: string }[]
  kpi: EmployeeKpi | null
  currentTask: EmployeeCurrentTask | null
  /** 「进入工作台 →」；P0 跟单/经理返回 null → 禁用态入口 */
  workspacePath: string | null
}

/** SOP 高级设置参数定义（角色模板下发，前端渲染参数微调） */
export interface SopParamDef {
  key: string
  label: string
  type: 'number' | 'select'
  options?: { value: string; label: string }[]
  defaultValue: string | number
  unit?: string
}

/** 角色模板（02 §2 GET /ai-employees/roles）：预填创建向导 ②-④ 步 */
export interface RoleTemplate {
  role: EmployeeRole
  name: string
  goal: string
  sopTemplateId: string
  sopParams: Record<string, string | number>
  sopParamDefs: SopParamDef[]
  skills: string[]
  tools: string[]
  knowledgeScope: string[]
  memoryConfig: { retentionDays: number; scope: string }
  kpiConfig: { metric: string; target: number; period: 'daily' }
}

/** POST /ai-employees/{id}/pause：暂停员工全部执行中任务（02 §3.4，仅 admin/manager） */
export interface PauseEmployeeResp {
  employeeId: string
  /** 本次置为 paused 的任务数 */
  pausedTasks: number
}

/** POST /ai-employees/{id}/resume：恢复员工（paused 任务重新排队续跑） */
export interface ResumeEmployeeResp {
  employeeId: string
  /** 本次恢复重排的任务数 */
  resumedTasks: number
}

/** 创建 AI 员工请求（02 §1.2；仅前端分步，后端单次 POST） */
export interface CreateEmployeeReq {
  role: EmployeeRole
  name: string
  goal: string
  sopTemplateId?: string
  sopParams?: Record<string, string | number>
  skills: string[]
  tools: string[]
  knowledgeScope: string[]
  memoryConfig?: { retentionDays: number; scope: string }
  workflowId?: string
  permissions: Record<string, boolean>
  approvalPolicy: {
    email_send: 'always' | 'high_value_only'
    quote: 'always'
    autoExecute: string[]
  }
  kpiConfig: { metric: string; target: number; period: 'daily' }
}
