import type {
  BatchTaskActionReq,
  BatchTaskActionResp,
  CreateTaskReq,
  CreateTaskResp,
  TaskDetail,
  TaskItem,
  TaskListReq,
  TaskLogsResp,
  TaskOpResp,
  TaskResumeResp,
  TaskRetryResp,
  TransferToHumanReq,
  TransferToHumanResp,
} from '@/api/types/tasks'
import type { PageResp } from '@/api/types/common'

import { request } from '../http'

/** GET /tasks/{id}：任务详情（进度卡 03 §1.4 / 兜底轮询 03 §5.2） */
export function getTask(taskId: string) {
  return request<TaskDetail>({ url: `/tasks/${taskId}`, method: 'GET' })
}

/** GET /tasks/{id}/logs?after={logId}&limit=50：日志增量轮询（14 §3.3） */
export function getTaskLogs(taskId: string, after = '', limit = 50) {
  return request<TaskLogsResp>({
    url: `/tasks/${taskId}/logs`,
    method: 'GET',
    params: after ? { after, limit } : { limit },
  })
}

/** GET /tasks：任务列表（14 §3.1 status Tab / employeeId / type / keyword / 分页） */
export function getTasks(params: TaskListReq) {
  return request<PageResp<TaskItem>>({ url: '/tasks', method: 'GET', params })
}

/** POST /tasks：通用新建任务（14 §3.2，`+ 新任务` 统一入口；type 决定 SOP/权限） */
export function createTask(data: CreateTaskReq) {
  return request<CreateTaskResp>({ url: '/tasks', method: 'POST', data })
}

/** POST /tasks/{id}/retry：失败重试（P0 范围，14 §3.5） */
export function retryTask(taskId: string) {
  return request<TaskRetryResp>({ url: `/tasks/${taskId}/retry`, method: 'POST' })
}

/** POST /tasks/{id}/pause：暂停（14 §3.6，P1-X-30） */
export function pauseTask(taskId: string) {
  return request<TaskOpResp>({ url: `/tasks/${taskId}/pause`, method: 'POST' })
}

/** POST /tasks/{id}/resume：恢复（14 §3.6，已产生检查点则从检查点续跑） */
export function resumeTask(taskId: string) {
  return request<TaskResumeResp>({ url: `/tasks/${taskId}/resume`, method: 'POST' })
}

/** POST /tasks/{id}/cancel：取消（14 §3.6，终态 canceled） */
export function cancelTask(taskId: string) {
  return request<TaskOpResp>({ url: `/tasks/${taskId}/cancel`, method: 'POST' })
}

/** POST /tasks/{id}/transfer-to-human：转人工（14 §3.6，追加交接摘要） */
export function transferTaskToHuman(taskId: string, data: TransferToHumanReq) {
  return request<TransferToHumanResp>({
    url: `/tasks/${taskId}/transfer-to-human`,
    method: 'POST',
    data,
  })
}

/** POST /tasks/batch：失败批量处理（14 §3.7，多选重试 / 转人工，1..50） */
export function batchTaskAction(data: BatchTaskActionReq) {
  return request<BatchTaskActionResp>({ url: '/tasks/batch', method: 'POST', data })
}
