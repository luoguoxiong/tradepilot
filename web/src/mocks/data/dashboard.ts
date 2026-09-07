import type { DashboardSummary } from '@/api/types/dashboard'

/**
 * 01 Dashboard mock 内存态（01 接口文档 v0.2；00 §5.1 降级矩阵 D1~D3）：
 * - kpis 仅 new_customers/new_inquiries（D1：09/10 P1，不返回未启用 metric）；
 * - pendingItems 仅 high_value_overdue/customer_reply（D2：quote_approval/order_delay_risk 不返回）；
 * - 无 dailyReport 字段（D3：13 为 P1，入口隐藏，接口保留 40401）。
 */
export const mockDashboardSummary: DashboardSummary = {
  greeting: { onlineEmployeeCount: 4, onlineEmployeeTotal: 6 },
  kpis: [
    {
      metric: 'new_customers',
      value: 28,
      changePct: 20,
      trend: 'up',
      comparePeriod: 'vs_last_week',
    },
    {
      metric: 'new_inquiries',
      value: 8,
      changePct: -15,
      trend: 'down',
      comparePeriod: 'vs_last_week',
    },
  ],
  aiEmployees: [
    {
      employeeId: 'emp_1',
      name: 'AI 获客员工',
      role: 'lead_hunter',
      status: 'working',
      currentAction: '正在寻找美国跑鞋品牌',
      todayOutput: { label: '今日找到客户', count: 28, unit: '个' },
    },
    {
      employeeId: 'emp_3',
      name: 'AI 跟进员工',
      role: 'follow_up',
      status: 'waiting_approval',
      currentAction: '等待 3 个任务审核',
      todayOutput: { label: '今日跟进', count: 8, unit: '个' },
      waitingApprovalCount: 3,
    },
    {
      employeeId: 'emp_2',
      name: 'AI 销售员工',
      role: 'sales',
      status: 'working',
      currentAction: '正在回复 ABC Sports 询盘',
      todayOutput: { label: '今日回复', count: 12, unit: '封' },
    },
    {
      employeeId: 'emp_4',
      name: 'AI 跟单员工',
      role: 'merchandiser',
      status: 'idle',
      currentAction: '暂无订单跟进任务（D4 占位）',
      todayOutput: { label: '今日跟单', count: 0, unit: '单' },
    },
  ],
  highValueCustomers: [
    { customerId: 'cus_1', companyName: 'ABC Sports', score: 92, country: 'US' },
    { customerId: 'cus_4', companyName: 'Nordic Gear', score: 85, country: 'SE' },
    { customerId: 'cus_2', companyName: 'Running Pro', score: 78, country: 'DE' },
  ],
  pendingItems: [
    { type: 'high_value_overdue', count: 5, level: 'warning', link: '/crm?overdue=7d' },
    { type: 'customer_reply', count: 2, level: 'warning', link: '/inbox?unread=true' },
  ],
}
