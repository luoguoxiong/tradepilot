/**
 * @tradepilot/tools —— ToolDefinition + 内置工具（后端技术方案 05 §3）。
 * 校验链①②④在 ToolRegistry；风险分流③（Approval Gate）在 packages/runtime。
 */
export type { ToolContext, ToolDefinition, BufferedTaskEvent } from './registry.js';
export { ToolRegistry, writeToolLog, toolIdempotencyKey, withIdempotency } from './registry.js';
export {
  registerSearchTools,
  mapDecisionInfluence,
  DEFAULT_JOB_TITLES,
} from './builtin/search-tools.js';
export {
  registerCrmTools,
  crmReadTool,
  crmWriteTool,
  emailReadTool,
  emailSendTool,
  knowledgeSearchTool,
  writeCustomerActivity,
  type EmailSendInput,
} from './builtin/crm-tools.js';
export {
  configureEmailSend,
  isEmailSendConfigured,
  getEmailSendConfig,
} from './builtin/email-send-config.js';
export {
  getOrgTimezone,
  assertOrgSearchQuota,
  configureOrgSearchQuota,
} from './builtin/quotas.js';
export {
  checkEmailContentCompliance,
  assertEmailContentCompliance,
  setEmailComplianceHook,
  resetEmailCompliance,
} from './builtin/content-compliance.js';
export type { ComplianceFinding } from './builtin/content-compliance.js';
export { searchKnowledgeChunks } from './builtin/knowledge-search.js';
export type {
  KnowledgeSearchParams,
  KnowledgeSearchHit,
  KnowledgeSearchResult,
} from './builtin/knowledge-search.js';

import { ToolRegistry } from './registry.js';
import { registerSearchTools } from './builtin/search-tools.js';
import { registerCrmTools } from './builtin/crm-tools.js';

/** P0 工具全集注册（05 §3：MVP 内置工具清单） */
export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerSearchTools((t) => registry.register(t));
  registerCrmTools((t) => registry.register(t));
  return registry;
}
