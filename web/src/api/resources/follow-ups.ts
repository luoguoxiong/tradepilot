import { request } from '../http'
import type { PageResp } from '../types/common'
import type {
  ApplyStrategyReq,
  ApplyStrategyResp,
  FollowUpExecution,
  FollowUpStrategy,
  FollowUpSummary,
  FollowUpTaskItem,
  FollowUpTaskQuery,
  UpsertStrategyReq,
} from '../types/follow-up'

/** 07-AI自动跟进（接口文档 07 §2 接口清单） */

/** GET /follow-ups/summary：总览统计（executingCount + 各 Tab 数量） */
export function getFollowUpSummary() {
  return request<FollowUpSummary>({ url: '/follow-ups/summary', method: 'GET' })
}

/** GET /follow-up-tasks：跟进任务列表（tab/keyword/分页） */
export function getFollowUpTasks(params: FollowUpTaskQuery) {
  return request<PageResp<FollowUpTaskItem>>({ url: '/follow-up-tasks', method: 'GET', params })
}

/** POST /follow-up-tasks/{id}/pause：暂停单个客户跟进（如客户已回复） */
export function pauseFollowUpTask(taskId: string) {
  return request<{ followUpTaskId: string; status: 'paused' }>({
    url: `/follow-up-tasks/${taskId}/pause`,
    method: 'POST',
  })
}

/** POST /follow-up-tasks/{id}/skip：跳过下一步 */
export function skipFollowUpTask(taskId: string) {
  return request<{ followUpTaskId: string; nextRunAt: string }>({
    url: `/follow-up-tasks/${taskId}/skip`,
    method: 'POST',
  })
}

/** GET /follow-up-strategies：策略列表 */
export function getFollowUpStrategies() {
  return request<PageResp<FollowUpStrategy>>({
    url: '/follow-up-strategies',
    method: 'GET',
    params: { page: 1, pageSize: 50 },
  })
}

/** POST /follow-up-strategies：新建策略（dayOffset 重复返回 42201） */
export function createFollowUpStrategy(data: UpsertStrategyReq) {
  return request<{ strategyId: string }>({
    url: '/follow-up-strategies',
    method: 'POST',
    data,
  })
}

/** PUT /follow-up-strategies/{id}：编辑策略 */
export function updateFollowUpStrategy(strategyId: string, data: UpsertStrategyReq) {
  return request<{ strategyId: string }>({
    url: `/follow-up-strategies/${strategyId}`,
    method: 'PUT',
    data,
  })
}

/** DELETE /follow-up-strategies/{id}：删除策略（默认策略禁删，被引用返回 40901） */
export function deleteFollowUpStrategy(strategyId: string) {
  return request<{ deleted: boolean }>({
    url: `/follow-up-strategies/${strategyId}`,
    method: 'DELETE',
  })
}

/** GET /follow-up-strategies/{id}/executions：执行记录（skipped 带 skipReason） */
export function getFollowUpExecutions(strategyId: string) {
  return request<PageResp<FollowUpExecution>>({
    url: `/follow-up-strategies/${strategyId}/executions`,
    method: 'GET',
  })
}

/** POST /follow-up-strategies/{id}/apply：应用策略到客户（单选/批量；无进行中任务才创建） */
export function applyFollowUpStrategy(strategyId: string, data: ApplyStrategyReq) {
  return request<ApplyStrategyResp>({
    url: `/follow-up-strategies/${strategyId}/apply`,
    method: 'POST',
    data,
  })
}
