import type {
  CreateEmployeeReq,
  EmployeeCard,
  PauseEmployeeResp,
  ResumeEmployeeResp,
  RoleTemplate,
} from '@/api/types/employees'
import type { PageResp } from '@/api/types/common'
import type { TaskItem } from '@/api/types/tasks'

import { request } from '../http'

/** GET /ai-employees：员工卡片列表（02 §3.1，全量 6 卡） */
export function getEmployees() {
  return request<PageResp<EmployeeCard>>({ url: '/ai-employees', method: 'GET' })
}

/** GET /ai-employees/roles：角色模板清单（创建向导预填，02 §2） */
export function getEmployeeRoles() {
  return request<RoleTemplate[]>({ url: '/ai-employees/roles', method: 'GET' })
}

/** POST /ai-employees：创建 AI 员工（02 §3.2，仅 admin/manager） */
export function createEmployee(data: CreateEmployeeReq) {
  return request<{ employeeId: string }>({ url: '/ai-employees', method: 'POST', data })
}

/** GET /ai-employees/{id}/tasks：该员工任务列表（复用 14，02 §3.3） */
export function getEmployeeTasks(employeeId: string) {
  return request<PageResp<TaskItem>>({
    url: `/ai-employees/${employeeId}/tasks`,
    method: 'GET',
  })
}

/** POST /ai-employees/{id}/pause：暂停员工全部执行中任务（02 §3.4，仅 admin/manager） */
export function pauseEmployee(employeeId: string) {
  return request<PauseEmployeeResp>({
    url: `/ai-employees/${employeeId}/pause`,
    method: 'POST',
  })
}

/** POST /ai-employees/{id}/resume：恢复员工（paused 任务重新排队续跑） */
export function resumeEmployee(employeeId: string) {
  return request<ResumeEmployeeResp>({
    url: `/ai-employees/${employeeId}/resume`,
    method: 'POST',
  })
}
