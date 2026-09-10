/**
 * LLM Gateway（后端技术方案 05 §6）：
 * Provider 适配（openai/anthropic/deepseek/azure + mock）· org 级路由（ai_model_setting 场景命中→默认兜底）
 * · Zod 结构化输出（失败重试 2 次）· llm_call 全量记账 + budgetLimit 跨阈值告警不熔断
 * （16 FR-10 MVP 增量口径：调用时当月累计，跨阈值首超上报一次；Cron 10min 汇总 + 80%/100% 两级随 M5 #9 复核）。
 * M3 mock provider：Zod schema 驱动的确定性产出，保证三工作流全链路可测（风险对策 §5.7）。
 */
import type { Logger } from 'pino';
import { withOrg, type Db } from '@tradepilot/db';
import { schema } from '@tradepilot/db';
import { createId } from '@tradepilot/core';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { ZodType } from 'zod';
import { resolveActiveModel } from './model-config.js';

export type LlmProvider = 'mock' | 'openai' | 'anthropic' | 'deepseek' | 'azure';

/** 合法 provider 白名单：台账存的是自由文本，运行时须收敛，未知值回落默认 provider */
const LLM_PROVIDERS: readonly LlmProvider[] = ['mock', 'openai', 'anthropic', 'deepseek', 'azure'];

export interface GatewayOptions {
  provider: LlmProvider;
  /** 服务端密钥库引用（08 §2：key 名存配置，真实 key 在 env/密管） */
  apiKey?: string;
  baseUrl?: string;
  defaultModel: string;
  /**
   * 凭据加密主密钥（64 hex）：用于解密 ai_model.api_key_enc（16 FR-10 扩展的 org 级模型选用）。
   * 缺省则台账 apiKey 不可用，回落 opts.apiKey。
   */
  encryptionKey?: string;
  /**
   * 预算超限告警回调（16 FR-10 MVP：跨阈值首超时上报一次；Worker 侧接 q:notify，
   * 未接线时仅 logger.warn —— 仅告警不熔断，LLM 调用不受影响）。
   */
  alert?: (info: BudgetAlertInfo) => void;
}

/** 预算超限告警载荷（05 §6.4 / M3-15） */
export interface BudgetAlertInfo {
  orgId: string;
  scene: string;
  /** 当月场景累计（llm_call.cost_usd sum，字符串避免精度问题） */
  totalUsd: string;
  budgetUsd: string;
}

export interface ModelTarget {
  provider: LlmProvider;
  model: string;
  temperature: number;
  maxTokens: number;
  /** 场景未配置时的默认兜底（降级链标记，05 §6.2） */
  degraded: boolean;
  /** org 级选用模型的端点/凭据（台账来源；缺省回落 GatewayOptions） */
  baseUrl?: string;
  apiKey?: string;
}

export interface LlmInvokeMeta {
  orgId: string;
  taskId?: string;
  employeeId?: string;
  /** 图节点 id */
  node: string;
  /** org 场景（ai_model_setting.scene：lead_hunting/email_reply/follow_up/analysis） */
  scene: string;
  promptRef?: string;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  degraded: boolean;
  model: string;
}

export interface StructuredResult<T> {
  data: T;
  usage: LlmUsage;
}

const RETRY_LIMIT = 3; // 首次 + 自动重试 2 次（Runtime §4.8 决议值）

/** 粗估单价（USD / 1M tokens）；M4 接入计费表后替换（15 成本报表数据源） */
const PRICE_PER_MTOK: Record<string, { prompt: number; completion: number }> = {
  'gpt-4o-mini': { prompt: 0.15, completion: 0.6 },
  'gpt-4o': { prompt: 2.5, completion: 10 },
  'gpt-4.1-mini': { prompt: 0.4, completion: 1.6 },
  'claude-3-5-haiku': { prompt: 0.8, completion: 4 },
  'claude-sonnet-4-5': { prompt: 3, completion: 15 },
  'deepseek-chat': { prompt: 0.27, completion: 1.1 },
};

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const price = PRICE_PER_MTOK[model];
  if (!price) {
    return 0;
  }
  return (
    (promptTokens / 1_000_000) * price.prompt + (completionTokens / 1_000_000) * price.completion
  );
}

/**
 * 预算跨阈值判定（16 FR-10 MVP 口径 / M3-15）：仅当「前值 ≤ 预算 < 后值」时返回 true，
 * 即当月累计从预算内首次越界上报一次，持续超限不重复告警；不熔断（LLM 调用路径不受影响）。
 */
export function crossedBudget(
  prevTotalUsd: number,
  nextTotalUsd: number,
  budgetUsd: number,
): boolean {
  return nextTotalUsd > budgetUsd && prevTotalUsd <= budgetUsd;
}

export class LlmGateway {
  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
    private readonly opts: GatewayOptions,
  ) {}

  /**
   * org 级路由（05 §6.2 / 16 FR-10 扩展）：优先级
   * ① 系统设置「AI 模型配置」该 org 选用的大语言模型（provider/凭据/模型/温度/maxTokens）；
   *    场景配置（ai_model_setting）仅保留温度/maxTokens 精调，模型以选用为准（全服务统一口径）。
   * ② 场景配置（ai_model_setting）命中：沿用环境变量 provider + 场景模型；
   * ③ 默认兜底：环境变量 defaultModel（degraded 标记）。
   */
  async resolveTarget(orgId: string, scene: string): Promise<ModelTarget> {
    // 台账选用独立事务读取：失败（未建表/权限异常）不得污染场景查询所在事务，仅降级告警
    const active = await resolveActiveModel(this.db, orgId, 'llm', this.opts.encryptionKey).catch(
      (err: unknown) => {
        this.logger.warn(
          { orgId, err: err instanceof Error ? err.message : String(err) },
          '读取 AI 模型配置失败，回落场景/默认模型',
        );
        return null;
      },
    );

    const sceneRow = await withOrg(this.db, orgId, async (tx) => {
      const [row] = await tx
        .select({
          model: schema.aiModelSetting.model,
          temperature: schema.aiModelSetting.temperature,
          maxTokens: schema.aiModelSetting.maxTokens,
        })
        .from(schema.aiModelSetting)
        .where(and(eq(schema.aiModelSetting.orgId, orgId), eq(schema.aiModelSetting.scene, scene)))
        .limit(1);
      return row ?? null;
    });

    if (active) {
      const provider = LLM_PROVIDERS.includes(active.provider as LlmProvider)
        ? (active.provider as LlmProvider)
        : this.opts.provider;
      if (provider !== active.provider) {
        this.logger.warn(
          { orgId, configured: active.provider },
          '未支持的 LLM provider，回落环境变量 provider',
        );
      }
      return {
        provider,
        model: active.model,
        temperature: sceneRow ? Number(sceneRow.temperature) : active.temperature,
        maxTokens: sceneRow ? sceneRow.maxTokens : (active.maxTokens ?? 4096),
        degraded: false,
        ...(active.baseUrl !== undefined && { baseUrl: active.baseUrl }),
        ...(active.apiKey !== undefined && { apiKey: active.apiKey }),
      };
    }

    if (sceneRow) {
      return {
        provider: this.opts.provider,
        model: sceneRow.model,
        temperature: Number(sceneRow.temperature),
        maxTokens: sceneRow.maxTokens,
        degraded: false,
      };
    }

    this.logger.warn({ orgId, scene }, '未配置 AI 模型与场景模型，使用默认模型兜底（degraded）');
    return {
      provider: this.opts.provider,
      model: this.opts.defaultModel,
      temperature: 0.7,
      maxTokens: 4096,
      degraded: true,
    };
  }

  /** 结构化输出（05 §6.3）：所有 LLM 节点强制 Zod 校验，解析失败重试 2 次 → 仍失败抛错（节点失败语义） */
  async structured<T>(
    meta: LlmInvokeMeta,
    schemaOut: ZodType<T>,
    messages: { system: string; user: string },
  ): Promise<StructuredResult<T>> {
    const target = await this.resolveTarget(meta.orgId, meta.scene);
    const startedAt = Date.now();

    if (target.provider === 'mock') {
      const data = mockStructured(schemaOut, 'root') as T;
      const usage: LlmUsage = {
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: Date.now() - startedAt,
        degraded: target.degraded,
        model: 'mock',
      };
      await this.record(meta, target, usage, 0);
      return { data, usage };
    }

    let lastError: unknown = null;
    // 自纠正重试（项目硬约束 / P1 教训，M3-07）：校验失败的具体原因回喂下一次请求，
    // 让模型按反馈修正（补漏字段 / 改类型 / 删未知键），而非用相同输入盲目重试。
    let retryHint: string | null = null;
    for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
      try {
        const model = this.createChatModel(target);
        const userContent = retryHint
          ? `${messages.user}\n\n【结构化输出校验反馈】${retryHint}\n请严格按 schema 修正：字段名一致、类型与必填正确、禁止新增未定义字段，只输出 JSON。`
          : messages.user;
        const raw = await model.invoke([
          { role: 'system', content: messages.system },
          { role: 'user', content: userContent },
        ]);
        // withStructuredOutput 走 tool-calling；此处直接解析 JSON 文本（兼容所有 provider 的结构化协议差异）
        const contentText =
          typeof raw.content === 'string'
            ? raw.content
            : Array.isArray(raw.content)
              ? raw.content.map((c) => ('text' in c ? String(c.text) : '')).join('')
              : '';
        const jsonText = extractJson(contentText);
        let rawJson: unknown;
        try {
          rawJson = JSON.parse(jsonText);
        } catch {
          retryHint = '输出不是合法 JSON（未解析出 JSON 对象/数组）';
          throw new Error(retryHint);
        }
        const parsed = schemaOut.safeParse(rawJson);
        if (!parsed.success) {
          retryHint = parsed.error.issues.map((i) => i.message).join('; ');
          throw new Error(`结构化输出校验失败: ${retryHint}`);
        }
        const usageMeta = raw.usage_metadata;
        const usage: LlmUsage = {
          promptTokens: usageMeta?.input_tokens ?? 0,
          completionTokens: usageMeta?.output_tokens ?? 0,
          latencyMs: Date.now() - startedAt,
          degraded: target.degraded,
          model: target.model,
        };
        await this.record(
          meta,
          target,
          usage,
          estimateCost(target.model, usage.promptTokens, usage.completionTokens),
        );
        return { data: parsed.data, usage };
      } catch (err) {
        lastError = err;
        this.logger.warn(
          { node: meta.node, attempt, err: err instanceof Error ? err.message : String(err) },
          'LLM 结构化输出失败，重试中',
        );
      }
    }
    throw lastError instanceof Error ? lastError : new Error('LLM 结构化输出失败');
  }

  /** llm_call 全量记账（05 §6.4）；budgetLimit 超限告警不熔断 */
  private async record(
    meta: LlmInvokeMeta,
    target: ModelTarget,
    usage: LlmUsage,
    costUsd: number,
  ): Promise<void> {
    await withOrg(this.db, meta.orgId, async (tx) => {
      await tx.insert(schema.llmCall).values({
        id: createId('trc'),
        orgId: meta.orgId,
        taskId: meta.taskId ?? null,
        employeeId: meta.employeeId ?? null,
        node: meta.node,
        scene: meta.scene,
        model: usage.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        costUsd: costUsd.toFixed(6),
        latencyMs: usage.latencyMs,
        degraded: usage.degraded,
      });
      // 预算告警（16 FR-10 MVP 增量口径 / M3-15：调用时汇总当月累计，跨阈值首超上报一次，不熔断；
      // Cron 每 10min 汇总 + 80%/100% 两级阈值随 M5 #9 复核，见 05 §6.4）
      const [setting] = await tx
        .select({ budgetLimit: schema.aiModelSetting.budgetLimit })
        .from(schema.aiModelSetting)
        .where(
          and(
            eq(schema.aiModelSetting.orgId, meta.orgId),
            eq(schema.aiModelSetting.scene, meta.scene),
          ),
        )
        .limit(1);
      const budget = setting?.budgetLimit;
      if (budget !== null && budget !== undefined) {
        const monthStart = new Date();
        monthStart.setUTCDate(1);
        monthStart.setUTCHours(0, 0, 0, 0);
        const [sum] = await tx
          .select({ total: sql<string>`coalesce(sum(${schema.llmCall.costUsd}), 0)` })
          .from(schema.llmCall)
          .where(
            and(
              eq(schema.llmCall.orgId, meta.orgId),
              eq(schema.llmCall.scene, meta.scene),
              gte(schema.llmCall.createdAt, monthStart),
            ),
          );
        const budgetUsd = Number(budget);
        const totalUsd = Number(sum?.total ?? 0);
        // 本次记账已含在 sum：前值 = 累计 - 本次（按落库精度还原，避免边界误差）
        const prevTotalUsd = totalUsd - Number(costUsd.toFixed(6));
        if (crossedBudget(prevTotalUsd, totalUsd, budgetUsd)) {
          this.logger.warn(
            { orgId: meta.orgId, scene: meta.scene, totalUsd, budgetUsd },
            'LLM 场景预算跨阈值超限（仅告警不熔断，16 FR-10）',
          );
          // 告警通道：Worker 侧接 q:notify（budget_limit）；未接线则仅留日志
          this.opts.alert?.({
            orgId: meta.orgId,
            scene: meta.scene,
            totalUsd: String(totalUsd),
            budgetUsd: String(budgetUsd),
          });
        }
      }
    });
  }

  /** 端点/凭据：台账选用模型优先，缺省回落 GatewayOptions（环境变量/密钥库） */
  private createChatModel(target: ModelTarget) {
    const { provider, model, temperature, maxTokens } = target;
    const apiKey = target.apiKey ?? this.opts.apiKey;
    const baseUrl = target.baseUrl ?? this.opts.baseUrl;
    if (provider === 'openai' || provider === 'azure') {
      return new ChatOpenAI({
        model,
        temperature,
        maxTokens,
        apiKey,
        configuration: baseUrl ? { baseURL: baseUrl } : undefined,
      });
    }
    if (provider === 'deepseek') {
      return new ChatOpenAI({
        model,
        temperature,
        maxTokens,
        apiKey,
        // deepseek 端点固定；仅台账显式端点可覆盖（环境变量 baseUrl 面向 openai 系，不参与）
        configuration: { baseURL: target.baseUrl ?? 'https://api.deepseek.com' },
      });
    }
    // anthropic
    return new ChatAnthropic({
      model,
      temperature,
      maxTokens,
      anthropicApiKey: apiKey,
    });
  }
}

import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';

/** 从模型文本中提取 JSON（兼容 ```json 围栏与前后缀文本） */
export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? (fenced[1] ?? text) : text).trim();
  const start = candidate.search(/[[{]/);
  if (start < 0) {
    return candidate;
  }
  const opener = candidate[start];
  const closer = opener === '{' ? '}' : ']';
  const end = candidate.lastIndexOf(closer);
  return end > start ? candidate.slice(start, end + 1) : candidate;
}

// ===== mock provider：Zod schema 驱动的确定性产出 =====

type ZodAny = ZodType<unknown> & {
  _def?: {
    typeName?: string;
    innerType?: ZodAny;
    value?: unknown;
    values?: readonly string[];
    shape?: () => Record<string, ZodAny>;
    element?: ZodAny;
    type?: ZodAny;
    options?: ZodAny[];
  };
};

function unwrap(schema: ZodAny): ZodAny {
  let cur = schema;
  const wrappers = new Set([
    'ZodOptional',
    'ZodNullable',
    'ZodDefault',
    'ZodEffects',
    'ZodCatch',
    'ZodBranded',
  ]);
  for (let i = 0; i < 10; i++) {
    const typeName = cur._def?.typeName ?? '';
    if (wrappers.has(typeName) && cur._def?.innerType) {
      cur = cur._def.innerType;
    } else {
      break;
    }
  }
  return cur;
}

function mockString(key: string, schema: ZodAny): string {
  const enumValues = schema._def?.values as readonly string[] | undefined;
  if (enumValues && enumValues.length > 0) {
    return enumValues[0] as string;
  }
  const k = key.toLowerCase();
  if (k.includes('language')) {
    return 'en';
  }
  if (k.includes('email')) {
    return 'contact@vendor1.example.com';
  }
  if (k.includes('subject')) {
    return 'Mock 主题：合作意向确认';
  }
  if (k.includes('body') || k.includes('content')) {
    return 'Dear partner,\n\nThis is a mock draft body generated by the M3 runtime pipeline (mock provider). Best regards, AI Sales.';
  }
  if (k.includes('query') || k.includes('queries')) {
    return 'carbon fiber insoles manufacturer USA';
  }
  return `mock-${key || 'text'}`;
}

function mockNumber(key: string): number {
  const k = key.toLowerCase();
  if (k.includes('confidence') || k.includes('probability')) {
    return 0.75;
  }
  if (k.includes('pct') || k.includes('percent')) {
    return 82;
  }
  if (k.includes('count') || k.includes('target')) {
    return 5;
  }
  return 50;
}

function mockBoolean(key: string): boolean {
  // grounded=true 走发送主路径（happy path）；need_info 分支由测试显式构造
  return key !== 'mustFallback';
}

/** schema 驱动 mock（mockStructured 入口） */
export function mockStructured(schema: ZodType<unknown>, key = 'root'): unknown {
  const inner = unwrap(schema as ZodAny);
  const typeName = inner._def?.typeName ?? '';

  if (typeName === 'ZodString') {
    return mockString(key, inner);
  }
  if (typeName === 'ZodNumber') {
    return mockNumber(key);
  }
  if (typeName === 'ZodBoolean') {
    return mockBoolean(key);
  }
  if (typeName === 'ZodEnum' || typeName === 'ZodNativeEnum') {
    const values = inner._def?.values;
    if (Array.isArray(values) && values.length > 0) {
      return values[0];
    }
    return '';
  }
  if (typeName === 'ZodLiteral') {
    return inner._def?.value;
  }
  if (typeName === 'ZodArray') {
    // zod3：ZodArray 的元素 schema 在 _def.type（element 是实例 getter，_def 上不存在）
    const element = inner._def?.element ?? inner._def?.type;
    return element ? [mockStructured(element as ZodType<unknown>, key)] : [];
  }
  if (typeName === 'ZodObject') {
    const shape = inner._def?.shape?.() ?? {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(shape)) {
      out[k] = mockStructured(v as ZodType<unknown>, k);
    }
    return out;
  }
  if (typeName === 'ZodUnion' || typeName === 'ZodDiscriminatedUnion') {
    const options = inner._def?.options;
    if (Array.isArray(options) && options.length > 0) {
      return mockStructured(options[0] as ZodType<unknown>, key);
    }
  }
  if (typeName === 'ZodRecord') {
    return {};
  }
  return null;
}
