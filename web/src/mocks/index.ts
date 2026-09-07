import { approvalHandlers } from './handlers/approvals'
import { authHandlers } from './handlers/auth'
import { conversationHandlers } from './handlers/conversations'
import { customer360Handlers } from './handlers/customer360'
import { customerHandlers } from './handlers/customers'
import { dashboardHandlers } from './handlers/dashboard'
import { employeeHandlers } from './handlers/employees'
import { followUpHandlers } from './handlers/follow-ups'
import { knowledgeHandlers } from './handlers/knowledge'
import { leadHandlers } from './handlers/leads'
import { orgHandlers } from './handlers/org'
import { settingsHandlers } from './handlers/settings'
import { taskHandlers } from './handlers/tasks'

/** 全量 mock handlers：按接口文档逐份实现（06 §5.3），MSW handler 与单测复用 */
export const handlers = [
  ...authHandlers,
  ...orgHandlers,
  ...settingsHandlers,
  ...approvalHandlers,
  ...conversationHandlers,
  ...customerHandlers,
  ...customer360Handlers,
  ...dashboardHandlers,
  ...knowledgeHandlers,
  ...employeeHandlers,
  ...followUpHandlers,
  ...leadHandlers,
  ...taskHandlers,
]
