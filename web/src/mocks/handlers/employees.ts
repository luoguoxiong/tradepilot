import { http, delay } from 'msw'

import { ErrorCode } from '@/api/error-codes'

import { mockRoleTemplates } from '../data/business'
import { LATENCY, fail, ok, readJson } from '../utils'

/** 02-AI数字员工中心：卡片列表 / 角色模板 / 创建（admin/manager） */
export const employeeHandlers = [
  http.get('/api/v1/ai-employees', async () => {
    await delay(LATENCY)
    const { mockEmployees, refreshEmployeeCards } = await import('../data/business')
    refreshEmployeeCards()
    return ok({ list: mockEmployees, total: mockEmployees.length, page: 1, pageSize: 20 })
  }),

  http.get('/api/v1/ai-employees/roles', async () => {
    await delay(LATENCY)
    return ok(mockRoleTemplates)
  }),

  http.post('/api/v1/ai-employees', async ({ request }) => {
    await delay(LATENCY)
    const body = await readJson<{
      role: string
      name: string
      kpiConfig?: { metric: string }
      tools?: string[]
      sopParams?: Record<string, string | number>
    }>(request)

    const template = mockRoleTemplates.find((t) => t.role === body.role)
    if (!template) return fail(ErrorCode.BAD_REQUEST, '未知员工角色')
    // 42201 契约样例（02 §3.2）：kpi metric 与角色不匹配
    if (body.kpiConfig?.metric && body.kpiConfig.metric !== template.kpiConfig.metric) {
      return fail(ErrorCode.BIZ_VALIDATION, 'kpiConfig.metric 与角色不匹配')
    }
    const { mockEmployees, refreshEmployeeCards } = await import('../data/business')
    if (mockEmployees.some((e) => e.role === body.role)) {
      return fail(ErrorCode.BIZ_VALIDATION, '该角色员工已存在，MVP 每角色限一个')
    }
    mockEmployees.push({
      employeeId: `emp_${mockEmployees.length + 1}`,
      role: body.role as never,
      name: body.name ?? template.name,
      status: 'idle',
      statusDetail: '已创建，等待任务',
      todayStats: [],
      kpi: null,
      currentTask: null,
      workspacePath: body.role === 'lead_hunter' ? '/lead-gen' : null,
    })
    refreshEmployeeCards()
    return ok({ employeeId: `emp_${mockEmployees.length}` })
  }),
]
