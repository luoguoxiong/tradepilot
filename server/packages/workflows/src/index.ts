/**
 * @tradepilot/workflows —— P0 三任务工作流装配（LangGraph 工作流 00）。
 * 提供三张注册表（prompts / outputSchemas / flows）+ SOP 定义 provider，
 * 由 worker（M3-13）注入 GraphCompiler / TaskRunner。
 * 依赖方向：workflows → runtime/tools/db/core/shared。
 */
export { createPromptRegistry, registerPrompts } from './prompts.js';
export {
  copilotSchema,
  createOutputSchemaRegistry,
  draftReplySchema,
  followUpContentSchema,
  intentSchema,
  leadScoreSchema,
  parsedGoalSchema,
  registerOutputSchemas,
  searchPlanSchema,
} from './output-schemas.js';
export { createFlowRegistry, registerFlows } from './flows.js';
export { WORKFLOW_SOP_DEFINITIONS, workflowSopProvider } from './sops.js';
