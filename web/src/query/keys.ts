/**
 * vue-query 层级化 key 工厂（03 §5.1）：保证失效精准，禁止裸数组散落各处。
 * 约定：`[模块, 作用域, ...参数]`；列表 key 必须包含全量查询参数。
 */
export const qk = {
  /** 员工列表（02，含状态/今日产出/KPI；staleTime 10min，变更点显式 invalidate） */
  employees: {
    all: ['employees'] as const,
    list: () => [...qk.employees.all, 'list'] as const,
  },
  /** 角色模板（02 创建向导预填，静态契约） */
  employeeRoles: ['employees', 'roles'] as const,

  /** 获客工作台头部（03 §1.1，聚合口径 30s） */
  leadHunterSummary: ['lead-hunter', 'summary'] as const,

  /** 发现客户（03 §1.6）：list(filters) / summary 档位计数 */
  leads: {
    all: ['leads'] as const,
    list: (filters: unknown) => [...qk.leads.all, 'list', filters] as const,
    summary: () => [...qk.leads.all, 'summary'] as const,
  },

  /** 任务（14）：detail / logs(after 增量) / steps */
  tasks: {
    all: ['tasks'] as const,
    detail: (taskId: string) => [...qk.tasks.all, 'detail', taskId] as const,
    logs: (taskId: string, after: string) => [...qk.tasks.all, 'logs', taskId, after] as const,
  },
} as const
