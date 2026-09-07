import type { TaskDetail, TaskLogsResp, TaskRetryResp, TaskStatus } from '@/api/types/tasks'
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

/** 任务列表（02 §3.3 员工任务列表复用；14 状态 Tab 筛选 P1） */
export function getTasks(params: {
  status?: TaskStatus
  employeeId?: string
  page?: number
  pageSize?: number
}) {
  return request<PageResp<TaskDetail>>({ url: '/tasks', method: 'GET', params })
}

/** POST /tasks/{id}/retry：失败重试（P0 范围，14 §3.5） */
export function retryTask(taskId: string) {
  return request<TaskRetryResp>({ url: `/tasks/${taskId}/retry`, method: 'POST' })
}
