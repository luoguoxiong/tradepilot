import { approvalHandlers } from './handlers/approvals'
import { authHandlers } from './handlers/auth'
import { knowledgeHandlers } from './handlers/knowledge'
import { orgHandlers } from './handlers/org'
import { settingsHandlers } from './handlers/settings'

/** 全量 mock handlers：按接口文档逐份实现（06 §5.3），MSW handler 与单测复用 */
export const handlers = [
  ...authHandlers,
  ...orgHandlers,
  ...settingsHandlers,
  ...approvalHandlers,
  ...knowledgeHandlers,
]
