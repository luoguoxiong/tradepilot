import { approvalHandlers } from './handlers/approvals'
import { authHandlers } from './handlers/auth'
import { employeeHandlers } from './handlers/employees'
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
  ...knowledgeHandlers,
  ...employeeHandlers,
  ...leadHandlers,
  ...taskHandlers,
]
