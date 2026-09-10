/**
 * @tradepilot/runtime —— TaskRunner / LangGraph 执行承载 / Memory / Approval Gate /
 * LLM Gateway（后端技术方案 05）。依赖方向：runtime → tools/workflows/db/core/shared。
 * M3 调度队列与 Runtime 基座里程碑实现。
 */
export type {
  EmployeeRuntime,
  NodeTxContext,
  OrgApprovalRule,
  OrgRuntime,
  TaskRunContext,
} from './context.js';
export {
  nextSeq,
  buildLogEvent,
  buildProgressEvent,
  buildStatusEvent,
  buildDoneEvent,
  TaskEventPublisher,
  flushBufferedEvents,
} from './events.js';
export { TaskEnqueuer, type EnqueueOptions } from './enqueue.js';
export {
  LlmGateway,
  mockStructured,
  extractJson,
  crossedBudget,
  type BudgetAlertInfo,
  type GatewayOptions,
  type LlmInvokeMeta,
  type LlmProvider,
  type LlmUsage,
  type ModelTarget,
  type StructuredResult,
} from './llm-gateway.js';
export { probeLlmConnection, type LlmProbeOptions, type LlmProbeResult } from './llm-probe.js';
export {
  DEFAULT_EMBEDDING_FALLBACK,
  DEFAULT_SEARCH_FALLBACK,
  resolveActiveModel,
  toEmbeddingProviderConfig,
  toSearchProviderConfig,
  type ActiveModelConfig,
  type AiModelKind,
  type EmbeddingFallbackOptions,
  type EmbeddingProviderConfig,
  type SearchFallbackOptions,
  type SearchProviderConfig,
} from './model-config.js';
export {
  APPROVAL_TTL_MS,
  ApprovalGate,
  type GateToolMeta,
  type GateVerdict,
} from './approval-gate.js';
export { releaseEmployeeIdle, type ReleaseEmployeeIdleParams } from './release-employee.js';
export { createCheckpointer, type CheckpointerHandle } from './checkpoint.js';
export {
  loadCustomerInsights,
  loadRecentMessages,
  readOrgMemory,
  type CustomerInsightSnapshot,
} from './memory.js';
export {
  ApprovalPendingError,
  BRANCH_KEY,
  DEFAULT_KEY,
  DONE_KEY,
  GraphCompiler,
  RECURSION_LIMIT,
  SimpleFlowRegistry,
  SimpleOutputSchemaRegistry,
  SimplePromptRegistry,
  renderTemplate,
  type CompiledTaskGraph,
  type CompilerDeps,
  type FlowNodeFn,
  type FlowRegistry,
  type FlowResult,
  type OutputSchemaRegistry,
  type PromptRegistry,
  type PromptTemplate,
} from './compiler.js';
export {
  TaskRunner,
  heartbeatKey,
  type ResumeHint,
  type RunTaskResult,
  type TaskRunnerDeps,
  type TaskSopProvider,
} from './runner.js';
