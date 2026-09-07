/**
 * Graph Compiler（后端技术方案 05 §4 / Runtime 总纲 §4.3）：
 * sop_template.content（SopGraphDefinition）→ LangGraph StateGraph。
 * - 动态 State 通道：stateKeys 每键 LastValue + `_branch`（flow 路由分支暂存）；
 * - 节点统一 runStep 骨架：tx upsert ai_task_step(running) → 执行 → tx step completed +
 *   ai_task.progressPct 累加/currentStep → 缓冲 SSE 事件 flush（防订阅方先于提交读库）；
 * - llm 节点 = LlmGateway.structured（scene=taskType，Zod 输出注册表）；
 * - tool 节点 = 校验链（白名单→schema→配额→风险分流）+ ApprovalGate（interrupt 抛
 *   ApprovalPendingError，runner 捕获后正常收尾 job，任务保持 waiting_approval）；
 * - flow 节点 = flows 注册表（state,ctx）→ {patch,branch,done}，done 写 `_branch=DONE` 走 END；
 * - 出边统一条件边 router：doneWhen 提前结束 → 分支键 → 缺省边；
 * - checkpointer（PostgresSaver）持久化超步，resume = invoke(null)（幂等：步骤 upsert/工具幂等键）。
 */
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import {
  Annotation,
  END,
  START,
  StateGraph,
  type BaseChannel,
  type BaseCheckpointSaver,
  type LangGraphRunnableConfig,
} from '@langchain/langgraph';
import type { ZodType } from 'zod';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { withOrg, schema, type Db, type Tx } from '@tradepilot/db';
import { BizException, ErrorCode, createId } from '@tradepilot/core';
import {
  sopGraphDefinitionSchema,
  stripSensitiveFields,
  TASK_STATUS,
  type SopFlowNode,
  type SopGraphDefinition,
  type SopLlmNode,
  type SopNode,
  type SopToolNode,
  type TaskLogType,
} from '@tradepilot/shared';
import type { ToolRegistry } from '@tradepilot/tools';
import {
  writeToolLog,
  type BufferedTaskEvent,
  type ToolContext,
  type ToolDefinition,
} from '@tradepilot/tools';
import type { TaskRunContext } from './context.js';
import { flushBufferedEvents, type TaskEventPublisher } from './events.js';
import type { LlmGateway } from './llm-gateway.js';
import type { ApprovalGate, GateToolMeta } from './approval-gate.js';

/** flow 节点完成后的分支键 → 条件边 END（提前结束语义） */
export const DONE_KEY = '__done__';
/** 无分支命中时走缺省边（无 when 的首条出边） */
export const DEFAULT_KEY = '__default__';
/** flow 路由分支暂存通道（LastValue，节点 patch 显式覆盖防脏读） */
export const BRANCH_KEY = '_branch';
/** 循环图 recursionLimit（获客 loop 多轮，Runtime §4.4） */
export const RECURSION_LIMIT = 200;

/** 审批挂起异常：runner 捕获后正常结束 job（不算失败），任务保持 waiting_approval */
export class ApprovalPendingError extends Error {
  constructor(public readonly approvalId: string) {
    super(`任务进入人工审批挂起: ${approvalId}`);
    this.name = 'ApprovalPendingError';
  }
}

/** ===== 注册表（workflows 包注入实现；compiler 只依赖接口）===== */

/** promptRef → 模板（{{var}} 插值，来源 sop content.prompts / 固化模板） */
export interface PromptTemplate {
  system: string;
  user: string;
}

export interface PromptRegistry {
  get(ref: string): PromptTemplate;
}

export class SimplePromptRegistry implements PromptRegistry {
  private readonly templates = new Map<string, PromptTemplate>();

  register(ref: string, tpl: PromptTemplate): void {
    if (this.templates.has(ref)) {
      throw new Error(`promptRef 重复注册: ${ref}`);
    }
    this.templates.set(ref, tpl);
  }

  get(ref: string): PromptTemplate {
    const tpl = this.templates.get(ref);
    if (!tpl) {
      throw new BizException(ErrorCode.NOT_FOUND, `promptRef 未注册: ${ref}`);
    }
    return tpl;
  }
}

/** outputSchema 注册名 → Zod（LLM 结构化输出契约，LangGraph 工作流 §6） */
export interface OutputSchemaRegistry {
  get(name: string): ZodType;
  has(name: string): boolean;
}

export class SimpleOutputSchemaRegistry implements OutputSchemaRegistry {
  private readonly schemas = new Map<string, ZodType>();

  register(name: string, schemaObj: ZodType): void {
    if (this.schemas.has(name)) {
      throw new Error(`outputSchema 重复注册: ${name}`);
    }
    this.schemas.set(name, schemaObj);
  }

  get(name: string): ZodType {
    const found = this.schemas.get(name);
    if (!found) {
      throw new BizException(ErrorCode.NOT_FOUND, `outputSchema 未注册: ${name}`);
    }
    return found;
  }

  has(name: string): boolean {
    return this.schemas.has(name);
  }
}

/** flow 节点路由函数：返回 patch / branch（写 _branch）/ done（→ END） */
export type FlowNodeFn = (
  state: Record<string, unknown>,
  ctx: TaskRunContext,
) => Promise<FlowResult> | FlowResult;

export interface FlowResult {
  patch?: Record<string, unknown>;
  branch?: string;
  done?: boolean;
}

export interface FlowRegistry {
  get(route: string): FlowNodeFn;
  has(route: string): boolean;
}

export class SimpleFlowRegistry implements FlowRegistry {
  private readonly flows = new Map<string, FlowNodeFn>();

  register(route: string, fn: FlowNodeFn): void {
    if (this.flows.has(route)) {
      throw new Error(`flow route 重复注册: ${route}`);
    }
    this.flows.set(route, fn);
  }

  get(route: string): FlowNodeFn {
    const fn = this.flows.get(route);
    if (!fn) {
      throw new BizException(ErrorCode.NOT_FOUND, `flow route 未注册: ${route}`);
    }
    return fn;
  }

  has(route: string): boolean {
    return this.flows.has(route);
  }
}

/** ===== 编译器 ===== */

type NodeFn = (
  state: Record<string, unknown>,
  config: LangGraphRunnableConfig,
) => Promise<Record<string, unknown>>;
/** 节点执行产物：state patch + 可选节点级日志（completeStep 事务内落 ai_task_log） */
interface NodeExecResult {
  patch: Record<string, unknown>;
  log?: { type: TaskLogType; content: string };
}
type NodeExec = (state: Record<string, unknown>, ctx: TaskRunContext) => Promise<NodeExecResult>;

/** 动态图构建的松散边界类型（Runtime 只依赖这组操作语义） */
interface LooseStateGraph {
  addNode(id: string, fn: NodeFn): this;
  addEdge(from: string, to: string): this;
  addConditionalEdges(
    source: string,
    router: (state: Record<string, unknown>, config: LangGraphRunnableConfig) => Promise<string>,
    pathMap: Record<string, string | typeof END>,
  ): this;
  compile(opts: { checkpointer?: BaseCheckpointSaver }): {
    invoke(input: unknown, config: LangGraphRunnableConfig): Promise<unknown>;
  };
}

export interface CompilerDeps {
  db: Db;
  redis: Redis;
  logger: Logger;
  publisher: TaskEventPublisher;
  gateway: LlmGateway;
  gate: ApprovalGate;
  tools: ToolRegistry;
  flows: FlowRegistry;
  prompts: PromptRegistry;
  outputSchemas: OutputSchemaRegistry;
  /** PostgresSaver（worker 装配；单测可省 → 无检查点直跑） */
  checkpointer?: BaseCheckpointSaver;
}

export interface CompiledTaskGraph {
  /** 初次执行：initial 为完整初始 State；resume（审批通过后）：input 传 null 从检查点续跑 */
  invoke(
    initial: Record<string, unknown> | null,
    ctx: TaskRunContext,
    opts?: { resume?: boolean },
  ): Promise<Record<string, unknown>>;
}

export class GraphCompiler {
  private readonly cache = new Map<string, CompiledTaskGraph>();

  constructor(private readonly deps: CompilerDeps) {}

  /**
   * SOP 图编译（入参 Zod 校验 05 §2）。
   * cacheKey = orgId:taskType@version（M3-17：含 org 维度，防多租户缓存交叉——
   * 未来 org 自定义 sop_template 落库后，同一 taskType@version 在不同 org 可能对应不同图）。
   */
  compile(
    orgId: string,
    taskType: string,
    sopRaw: unknown,
    stateKeys: readonly string[],
  ): CompiledTaskGraph {
    const sop = sopGraphDefinitionSchema.parse(sopRaw) as SopGraphDefinition;
    const cacheKey = `${orgId}:${taskType}@${sop.version}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const compiled = this.doCompile(sop, stateKeys);
    this.cache.set(cacheKey, compiled);
    return compiled;
  }

  private doCompile(sop: SopGraphDefinition, stateKeys: readonly string[]): CompiledTaskGraph {
    const spec: Record<string, BaseChannel> = {};
    for (const key of stateKeys) {
      spec[key] = Annotation<unknown>();
    }
    spec[BRANCH_KEY] = Annotation<unknown>();
    const StateAnnotation = Annotation.Root(spec);

    // 动态节点名（SOP data 驱动）超出 StateGraph 静态字面量推断能力，边界处放宽为松散接口
    const wf = new StateGraph(StateAnnotation) as unknown as LooseStateGraph;

    sop.nodes.forEach((node, idx) => {
      const seq = idx + 1; // smallint 步骤序号（upsert 幂等锚点 [taskId, seq]）
      const exec = this.buildExec(node);
      wf.addNode(node.id, this.wrapNode(node, seq, exec));
    });
    wf.addEdge(START, sop.entry);

    // 出边分组：含 when 分支或存在 doneWhen → 条件边 router；否则直连
    const byFrom = new Map<string, { to: string; when?: string }[]>();
    for (const e of sop.edges) {
      const list = byFrom.get(e.from) ?? [];
      list.push({ to: e.to, when: e.when });
      byFrom.set(e.from, list);
    }
    for (const [from, outs] of byFrom) {
      const branchMap = new Map<string, string>();
      for (const o of outs) {
        if (o.when) {
          branchMap.set(o.when, o.to);
        }
      }
      const unconditional = outs.filter((o) => !o.when);
      if (branchMap.size > 0 || sop.doneWhen) {
        const defaultTarget = unconditional[0]?.to ?? null;
        const pathMap: Record<string, string | typeof END> = { [DONE_KEY]: END };
        if (defaultTarget) {
          pathMap[DEFAULT_KEY] = defaultTarget;
        }
        for (const [key, to] of branchMap) {
          pathMap[key] = to;
        }
        wf.addConditionalEdges(
          from,
          this.buildRouter(sop, from, branchMap, defaultTarget),
          pathMap,
        );
      } else {
        for (const o of unconditional) {
          wf.addEdge(from, o.to);
        }
      }
    }
    // 无出边节点 → END
    for (const node of sop.nodes) {
      if (!byFrom.has(node.id)) {
        wf.addEdge(node.id, END);
      }
    }

    const graph = wf.compile({ checkpointer: this.deps.checkpointer });
    return {
      invoke: async (initial, ctx, opts) => {
        const config: LangGraphRunnableConfig = {
          configurable: { ctx, thread_id: ctx.taskId },
          recursionLimit: RECURSION_LIMIT,
        };
        const final = await graph.invoke(opts?.resume ? null : initial, config);
        return final as Record<string, unknown>;
      },
    };
  }

  /** 条件边 router：DONE（flow 提前结束）→ doneWhen → 分支键 → 缺省边 */
  private buildRouter(
    sop: SopGraphDefinition,
    fromId: string,
    branchMap: Map<string, string>,
    defaultTarget: string | null,
  ) {
    return async (
      state: Record<string, unknown>,
      config: LangGraphRunnableConfig,
    ): Promise<string> => {
      if (state[BRANCH_KEY] === DONE_KEY) {
        return DONE_KEY;
      }
      if (sop.doneWhen && this.deps.flows.has(sop.doneWhen)) {
        const ctx = config.configurable?.['ctx'] as TaskRunContext | undefined;
        if (ctx) {
          const r = await this.deps.flows.get(sop.doneWhen)(state, ctx);
          if (r.done) {
            return DONE_KEY;
          }
        }
      }
      const branch = state[BRANCH_KEY];
      if (typeof branch === 'string' && branchMap.has(branch)) {
        // langgraph addConditionalEdges(object pathMap) 语义：router 返回 pathMap 的「键」，
        // 由 ends 映射到目标节点；返回目标节点名会被判为 unknown destination。
        return branch;
      }
      if (defaultTarget) {
        return DEFAULT_KEY;
      }
      throw new BizException(
        ErrorCode.INTERNAL,
        `节点 ${fromId} 分支未命中且无缺省边: ${String(branch)}`,
      );
    };
  }

  /** 节点包装：runStep 骨架（步骤 upsert → 执行 → 完成/失败落库 + SSE flush） */
  private wrapNode(node: SopNode, seq: number, exec: NodeExec): NodeFn {
    return async (state, config) => {
      const ctx = config.configurable?.['ctx'] as TaskRunContext;
      ctx.nodeId = node.id;
      ctx.events.length = 0;
      await this.beginStep(ctx, node, seq);
      try {
        const { patch, log } = await exec(state, ctx);
        await this.completeStep(ctx, node, seq, log);
        return { ...patch, [BRANCH_KEY]: patch[BRANCH_KEY] ?? null };
      } catch (err) {
        if (!(err instanceof ApprovalPendingError)) {
          await this.failStep(ctx, node, seq, err);
        }
        throw err;
      }
    };
  }

  private buildExec(node: SopNode): NodeExec {
    if (node.kind === 'llm') {
      return this.llmExec(node);
    }
    if (node.kind === 'tool') {
      return this.toolExec(node);
    }
    return this.flowExec(node);
  }

  // ===== llm 节点 =====

  private llmExec(node: SopLlmNode): NodeExec {
    return async (state, ctx) => {
      const tpl = this.deps.prompts.get(node.promptRef);
      const vars: Record<string, unknown> = { ...state };
      const messages = {
        system: renderTemplate(tpl.system, vars),
        user: renderTemplate(tpl.user, vars),
      };
      const outSchema = node.outputSchema
        ? this.deps.outputSchemas.get(node.outputSchema)
        : undefined;
      const result = await this.deps.gateway.structured(
        {
          orgId: ctx.orgId,
          taskId: ctx.taskId,
          employeeId: ctx.employeeId,
          node: node.id,
          scene: ctx.taskType,
          promptRef: node.promptRef,
        },
        outSchema ?? z.record(z.unknown()),
        messages,
      );
      const log = node.logType
        ? { type: node.logType as TaskLogType, content: `LLM 输出: ${truncateJson(result.data)}` }
        : undefined;
      return { patch: applyOutputKey(node.outputKey, result.data, node.id), log };
    };
  }

  // ===== tool 节点 =====

  private toolExec(node: SopToolNode): NodeExec {
    return async (state, ctx) => {
      const tool = this.deps.tools.get(node.tool);
      this.deps.tools.assertAllowed(tool, ctx.employee.tools);
      const input = this.deps.tools.parseInput(tool, buildToolInput(node, state));
      await this.deps.tools.assertQuota(ctx, tool, ctx.employee.externalCallDailyLimit);

      // M3-08 风险单一口径：节点 risk 优先（SOP 内可对同一工具实例化抬高/放行），
      // 缺省回落工具注册表 riskLevel；避免「SOP 标注了 risk 但门控只看工具」的双轨漂移。
      const riskLevel = node.risk ?? tool.riskLevel;
      const meta: GateToolMeta = {
        name: tool.name,
        riskLevel,
        approvalType: node.approvalType ?? tool.approvalType,
      };
      const resumeInfo = ctx.bag.get('resumeApproval') as
        { nodeId?: string; approvalId?: string } | undefined;
      const isResume = resumeInfo?.nodeId === node.id;

      if (riskLevel !== 'low' && !isResume) {
        const verdict = await this.deps.gate.decide(meta, ctx, input as Record<string, unknown>);
        if (verdict.action === 'interrupt') {
          const approvalId = await this.deps.gate.enterWaiting(
            meta,
            ctx,
            input as Record<string, unknown>,
          );
          throw new ApprovalPendingError(approvalId);
        }
        if (verdict.action === 'auto_approve') {
          await this.deps.gate.recordAutoApprove(meta, ctx, input as Record<string, unknown>);
        }
      }
      if (isResume && tool.freshnessCheck) {
        const check = tool.freshnessCheck;
        const fresh = await this.execTool(tool, ctx, (toolCtx) => check(toolCtx, input));
        ctx.bag.delete('resumeApproval');
        if (!fresh) {
          throw new BizException(
            ErrorCode.CONFLICT,
            '新鲜度校验未通过，终止执行（审批挂起期间状态已变化）',
          );
        }
      }

      const result = await this.execTool(tool, ctx, (toolCtx) => tool.execute(toolCtx, input));
      const log = node.logType
        ? { type: node.logType as TaskLogType, content: `工具输出: ${truncateJson(result)}` }
        : undefined;
      return { patch: applyOutputKey(node.outputKey, result, node.id), log };
    };
  }

  /** 工具桥接（05 §4）：withOrg 单事务装配 ToolContext（log 绑定 ai_task_log + 事件缓冲） */
  private execTool<O>(
    tool: ToolDefinition<unknown, O>,
    ctx: TaskRunContext,
    fn: (toolCtx: ToolContext) => Promise<O>,
  ): Promise<O> {
    return withOrg(ctx.db, ctx.orgId, (tx: Tx) => {
      const toolCtx: ToolContext = {
        orgId: ctx.orgId,
        taskId: ctx.taskId,
        employeeId: ctx.employeeId,
        nodeId: ctx.nodeId,
        taskType: ctx.taskType,
        tx,
        redis: ctx.redis,
        logger: ctx.logger,
        now: ctx.now,
        bag: ctx.bag,
        log: (type, content, leadId) => writeToolLog(toolCtx, type, content, leadId),
        emit: (event: BufferedTaskEvent) => {
          ctx.events.push(event);
        },
      };
      return fn(toolCtx);
    });
  }

  // ===== flow 节点 =====

  private flowExec(node: SopFlowNode): NodeExec {
    return async (state, ctx) => {
      if (!node.route) {
        throw new BizException(ErrorCode.INTERNAL, `flow 节点 ${node.id} 缺少 route`);
      }
      const fn = this.deps.flows.get(node.route);
      const result = await fn(state, ctx);
      const patch: Record<string, unknown> = { ...(result.patch ?? {}) };
      patch[BRANCH_KEY] = result.done ? DONE_KEY : (result.branch ?? null);
      return { patch };
    };
  }

  // ===== runStep 落库 =====

  private async beginStep(ctx: TaskRunContext, node: SopNode, seq: number): Promise<void> {
    const now = ctx.now;
    await withOrg(ctx.db, ctx.orgId, (tx) =>
      tx
        .insert(schema.aiTaskStep)
        .values({
          id: createId('step'),
          orgId: ctx.orgId,
          taskId: ctx.taskId,
          seq,
          name: node.title ?? node.id,
          status: TASK_STATUS.RUNNING,
          startedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.aiTaskStep.taskId, schema.aiTaskStep.seq],
          set: {
            name: node.title ?? node.id,
            status: TASK_STATUS.RUNNING,
            startedAt: now,
            finishedAt: null,
          },
        }),
    );
  }

  private async completeStep(
    ctx: TaskRunContext,
    node: SopNode,
    seq: number,
    log?: { type: TaskLogType; content: string },
  ): Promise<void> {
    const now = new Date();
    const stepName = node.title ?? node.id;
    const progressPct = await withOrg(ctx.db, ctx.orgId, async (tx) => {
      await tx
        .update(schema.aiTaskStep)
        .set({ status: TASK_STATUS.COMPLETED, finishedAt: now })
        .where(and(eq(schema.aiTaskStep.taskId, ctx.taskId), eq(schema.aiTaskStep.seq, seq)));
      if (log) {
        const logId = createId('tlog');
        await tx.insert(schema.aiTaskLog).values({
          id: logId,
          orgId: ctx.orgId,
          taskId: ctx.taskId,
          occurredAt: now,
          type: log.type,
          content: log.content,
          leadId: null,
        });
        ctx.events.push({ type: 'log', payload: { logId, type: log.type, content: log.content } });
      }
      const progress = node.progress ?? 0;
      const [row] = await tx
        .update(schema.aiTask)
        .set({
          progressPct: sql`least(100, ${schema.aiTask.progressPct} + ${sql.raw(String(progress))})`,
          currentStep: stepName,
          updatedAt: now,
        })
        .where(eq(schema.aiTask.id, ctx.taskId))
        .returning({ progressPct: schema.aiTask.progressPct });
      return row?.progressPct ?? ctx.progressPct;
    });
    ctx.progressPct = progressPct;
    ctx.currentStep = stepName;
    ctx.events.push({ type: 'progress', payload: { progressPct, currentStep: stepName } });
    // 事务已提交，统一 flush 本节点缓冲的 SSE 事件（04 §6）
    await flushBufferedEvents(this.deps.publisher, ctx.taskId, ctx.events);
  }

  private async failStep(
    ctx: TaskRunContext,
    node: SopNode,
    seq: number,
    err: unknown,
  ): Promise<void> {
    const now = new Date();
    await withOrg(ctx.db, ctx.orgId, (tx) =>
      tx
        .update(schema.aiTaskStep)
        .set({ status: TASK_STATUS.FAILED, finishedAt: now })
        .where(and(eq(schema.aiTaskStep.taskId, ctx.taskId), eq(schema.aiTaskStep.seq, seq))),
    );
    this.deps.logger.warn(
      {
        taskId: ctx.taskId,
        nodeId: node.id,
        err: err instanceof Error ? err.message : String(err),
      },
      '节点执行失败',
    );
  }
}

// ===== 辅助 =====

/** {{var}} 插值（支持点路径；对象 JSON 序列化）。
 *  M3-16 / 08 §7：对象变量序列化前统一剥离敏感键（cost_price 等），LLM prompt 组装唯一出口兜底。 */
export function renderTemplate(tpl: string, vars: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const value = key
      .split('.')
      .reduce<unknown>(
        (acc, k) =>
          acc !== null && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined,
        vars,
      );
    if (value === undefined || value === null) {
      return '';
    }
    return typeof value === 'string' ? value : JSON.stringify(stripSensitiveFields(value));
  });
}

/** 节点输出装配：outputKey 指定；缺省对象展开合并 / 标量写节点 id 键 */
function applyOutputKey(
  outputKey: string | undefined,
  data: unknown,
  nodeId: string,
): Record<string, unknown> {
  if (outputKey) {
    return { [outputKey]: data };
  }
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return { [nodeId]: data };
}

/** 工具入参装配：静态 input + inputMap 从 State 取（inputMap 优先；键支持点路径/数组下标，如 'draft.subject'、'discovered.0.domain'） */
function buildToolInput(
  node: SopToolNode,
  state: Record<string, unknown>,
): Record<string, unknown> {
  const input: Record<string, unknown> = { ...(node.input ?? {}) };
  for (const [field, stateKey] of Object.entries(node.inputMap ?? {})) {
    const value = stateKey
      .split('.')
      .reduce<unknown>(
        (acc, k) =>
          acc !== null && acc !== undefined ? (acc as Record<string, unknown>)[k] : undefined,
        state,
      );
    if (value !== undefined) {
      input[field] = value;
    }
  }
  return input;
}

function truncateJson(data: unknown, max = 200): string {
  try {
    const text = JSON.stringify(data);
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch {
    return String(data);
  }
}
