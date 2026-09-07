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

  /** 客户（05）：list(filters 全量) / detail（批量改派乐观更新遍历 customers.all 回滚） */
  customers: {
    all: ['customers'] as const,
    list: (filters: unknown) => [...qk.customers.all, 'list', filters] as const,
    detail: (customerId: string) => [...qk.customers.all, 'detail', customerId] as const,
  },

  /** 团队成员（owner 转交/批量改派候选；org settings 同源） */
  orgMembers: ['org', 'members'] as const,

  /** 邮箱连接（16；inbox 来源筛选下拉） */
  mailboxes: ['settings', 'mailboxes'] as const,

  /** 联系人（05 §2，独立资源：页签列表/删除） */
  contacts: {
    all: ['contacts'] as const,
    list: (filters: unknown) => [...qk.contacts.all, 'list', filters] as const,
  },

  /** 活动（05 §2，全局时间线；客户 360° 同数据口径） */
  activities: {
    all: ['activities'] as const,
    list: (filters: unknown) => [...qk.activities.all, 'list', filters] as const,
  },

  /** 客户 360°（04）：detail / insight / 各页签列表（id 为入口，customer/lead 双源） */
  customer360: {
    all: ['customer360'] as const,
    detail: (id: string) => [...qk.customer360.all, 'detail', id] as const,
    insight: (id: string) => [...qk.customer360.all, 'insight', id] as const,
    products: (id: string) => [...qk.customer360.all, 'products', id] as const,
    contacts: (id: string, filters: unknown) =>
      [...qk.customer360.all, 'contacts', id, filters] as const,
    conversations: (id: string, filters: unknown) =>
      [...qk.customer360.all, 'conversations', id, filters] as const,
    activities: (id: string, filters: unknown) =>
      [...qk.customer360.all, 'activities', id, filters] as const,
  },

  /** 会话（06 销售工作台）：list(filters) / detail / copilot */
  conversations: {
    all: ['conversations'] as const,
    list: (filters: unknown) => [...qk.conversations.all, 'list', filters] as const,
    detail: (id: string) => [...qk.conversations.all, 'detail', id] as const,
    copilot: (id: string) => [...qk.conversations.all, 'copilot', id] as const,
  },

  /** 审批（12）：list(filters) / detail / logs；summary 供 Tab 与页面共享（notifyStore 暂不走 vue-query） */
  approvals: {
    all: ['approvals'] as const,
    list: (filters: unknown) => [...qk.approvals.all, 'list', filters] as const,
    detail: (id: string) => [...qk.approvals.all, 'detail', id] as const,
    logs: (id: string) => [...qk.approvals.all, 'logs', id] as const,
    summary: () => [...qk.approvals.all, 'summary'] as const,
  },
} as const
