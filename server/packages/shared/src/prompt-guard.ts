/**
 * Prompt 上下文守卫（08 安全设计与合规 §6/§7 · M3-16）：
 * ① 敏感字段防泄漏——08 §7：`product.cost_price`（采购成本）等成本字段禁止进 AI prompt；
 *    对进入 prompt 的结构化数据统一递归剥离 deny-list 键（数组/嵌套对象均覆盖）。
 * ② 外部内容注入纪律——08 §6：爬取网页 / 客户来信等不可信文本进 prompt 时必须包裹边界标记，
 *    让模型明确区分「指令」与「数据」，降低提示注入风险。
 *
 * 接线（M3）：compiler.renderTemplate 已对模板对象变量执行敏感键剥离（结构化数据统一出口）；
 * flows.loadThread 对客户来信（inbound）body 包边界标记。M4 RAG/文档检索内容进 prompt 时强制复用。
 * 只做值处理、不抛错（守卫失败回落原始值由调用方决定）。
 */

/** 默认敏感键（成本口径，仅限内部定价引擎输入；对外展示价/阶梯价不在其列） */
export const PROMPT_SENSITIVE_KEYS: readonly string[] = [
  'costPrice',
  'cost_price',
  'purchasePrice',
  'purchase_price',
  /** purchase_cost 别名与 purchase_price 同口径（08 §7 采购成本） */
  'purchase_cost',
  'unitCost',
  'unit_cost',
  '采购成本',
];

/** 不可信外部内容边界标记（08 §6） */
export const UNTRUSTED_BOUNDARY_BEGIN = '[UNTRUSTED_EXTERNAL_BEGIN]';
export const UNTRUSTED_BOUNDARY_END = '[UNTRUSTED_EXTERNAL_END]';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function strip(value: unknown, deny: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => strip(item, deny));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (deny.has(key)) {
        continue;
      }
      out[key] = strip(item, deny);
    }
    return out;
  }
  return value;
}

/**
 * 递归剥离敏感键并返回副本（不修改入参；非对象原样返回）。
 * @param extraDenyKeys 追加的 deny-list（按调用方字段口径扩展，如 M4 RAG 文档元数据）
 */
export function stripSensitiveFields<T>(value: T, extraDenyKeys: readonly string[] = []): T {
  const deny = new Set<string>(PROMPT_SENSITIVE_KEYS);
  for (const key of extraDenyKeys) {
    deny.add(key);
  }
  return strip(value, deny) as T;
}

/** 外部不可信文本 → 带边界标记的 prompt 片段（08 §6：邮件原文/网页正文注入前调用） */
export function boundExternal(content: string): string {
  return `${UNTRUSTED_BOUNDARY_BEGIN}\n${content}\n${UNTRUSTED_BOUNDARY_END}`;
}
