import type { AnalyticsMetric } from '@/api/types/analytics'

/** metric → i18n key（下钻抽屉标题 / 明细空态） */
export const METRIC_LABEL_KEY: Record<AnalyticsMetric, string> = {
  new_customers: 'dataCenter.metric.newCustomers',
  inquiries: 'dataCenter.metric.inquiries',
  new_quotes: 'dataCenter.metric.newQuotes',
  deals_closed: 'dataCenter.metric.dealsClosed',
  found_customers: 'dataCenter.metric.foundCustomers',
  replied_emails: 'dataCenter.metric.repliedEmails',
  saved_hours: 'dataCenter.metric.savedHours',
  promoted_inquiries: 'dataCenter.metric.promotedInquiries',
}

/** 明细行 type → i18n key（后端下钻 type 字段） */
export const ITEM_TYPE_LABEL_KEY: Record<string, string> = {
  customer: 'dataCenter.itemType.customer',
  conversation: 'dataCenter.itemType.conversation',
  quotation: 'dataCenter.itemType.quotation',
  message: 'dataCenter.itemType.message',
  found_customer: 'dataCenter.itemType.foundCustomer',
  replied_email: 'dataCenter.itemType.repliedEmail',
  follow_up: 'dataCenter.itemType.followUp',
}

/** 数据源行点击跳转（仅客户 / 报价有详情页，其余不跳转避免死链） */
export const ITEM_ROUTE: Record<string, (id: string) => string> = {
  customer: (id) => `/customers/${id}`,
  found_customer: (id) => `/customers/${id}`,
  quotation: (id) => `/quotes/${id}`,
}
