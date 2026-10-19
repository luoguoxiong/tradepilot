/**
 * 通用重试原语（后端技术方案 04 §5.3「节点级重试」/ 06 §1「外呼超时与重试在各驱动内配置」）。
 *
 * 两个消费方：
 * - **外呼驱动**（搜索/抓取等 integrations 适配器）：在**节点内**自愈瞬时故障（连接超时/连接重置/
 *   429/5xx），不产生任务级重跑，也不重复已完成节点的成本；
 * - **任务级重投**（worker processor）：据此判定失败是否可重试，决定 job 是否抛错交给 BullMQ
 *   按 attempts + 指数退避重投（04 §5.3）。
 *
 * 判定口径（宁可少重试，不可盲目重试）：
 * - `BizException` 默认**不可重试**（入参/状态/权限/校验类失败重试无益）；仅 `DEPENDENCY_UNAVAILABLE`
 *   （50301 依赖服务不可用）可重试；`RATE_LIMITED`（42901 员工日额度）属「转 paused 等次日重置」
 *   语义（03 §3.7），不可重试；
 * - 带 HTTP `status`/`statusCode` 的错误按状态码判定（408/425/429/5xx 可重试，其余确定性失败）；
 * - 网络栈错误码（Node + undici）与 `AbortError`/`TimeoutError`（AbortSignal.timeout 触发）可重试；
 * - 以上都判不出时按文案兜底识别（fetch failed / connect timeout / socket hang up …）；
 * - 递归下探 `cause`（undici 把 ConnectTimeoutError 挂在 `fetch failed` 的 cause 上）。
 */
import { ErrorCode } from './error-codes.js';
import { BizException } from './errors.js';

/** 可重试的网络/系统错误码 */
const RETRYABLE_ERROR_CODES = new Set([
  // Node 网络栈
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  // undici
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_REQUEST_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_RESPONSE_STATUS_CODE',
]);

/** 可重试的 HTTP 状态：408/425/429/5xx（其余 4xx 为确定性失败，重试无益） */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** 兜底文案识别（无法结构化判定时） */
const RETRYABLE_MESSAGE =
  /fetch failed|connect timeout|read timeout|headers timeout|body timeout|socket hang up|network (?:error|is unreachable|failed)|timed out|timeout error|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_/i;

/** cause 链下探深度上限（防循环引用） */
const MAX_CAUSE_DEPTH = 4;

/** 缺省总尝试次数（首次 + 2 次重试；06 §1「失败重试 2 次」口径） */
export const DEFAULT_RETRY_ATTEMPTS = 3;
/** 缺省退避基数 ms */
export const DEFAULT_RETRY_DELAY_MS = 400;
/** 缺省退避上限 ms（防止任务被长时间拖住） */
export const DEFAULT_RETRY_MAX_DELAY_MS = 8_000;
/** 缺省退避倍率 */
export const DEFAULT_RETRY_FACTOR = 2;

/** 可重试 HTTP 状态判定 */
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/** 瞬时故障判定：可重试返回 true（详见文件头口径） */
export function isRetryableError(err: unknown, depth = 0): boolean {
  if (err === null || err === undefined) {
    return false;
  }
  if (typeof err === 'string') {
    return RETRYABLE_MESSAGE.test(err);
  }
  if (typeof err !== 'object') {
    return false;
  }
  if (err instanceof BizException) {
    return err.code === ErrorCode.DEPENDENCY_UNAVAILABLE;
  }
  if (depth > MAX_CAUSE_DEPTH) {
    return false;
  }
  const e = err as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  const status =
    typeof e.status === 'number'
      ? e.status
      : typeof e.statusCode === 'number'
        ? e.statusCode
        : undefined;
  if (status !== undefined) {
    return isRetryableStatus(status);
  }
  if (typeof e.code === 'string' && RETRYABLE_ERROR_CODES.has(e.code)) {
    return true;
  }
  if (e.name === 'AbortError' || e.name === 'TimeoutError' || e.name === 'ConnectTimeoutError') {
    return true;
  }
  if (typeof e.message === 'string' && RETRYABLE_MESSAGE.test(e.message)) {
    return true;
  }
  if (e.cause !== undefined && e.cause !== err) {
    return isRetryableError(e.cause, depth + 1);
  }
  return false;
}

/** 重试元信息（onRetry 回调入参） */
export interface RetryInfo {
  /** 本次失败的是第几次尝试（从 1 起） */
  attempt: number;
  /** 总尝试次数 */
  attempts: number;
  /** 本次退避时长 ms */
  delayMs: number;
  /** 触发重试的错误 */
  err: unknown;
}

export interface RetryOptions {
  /** 总尝试次数（含首次；默认 3） */
  attempts?: number;
  /** 退避基数 ms（默认 400） */
  initialDelayMs?: number;
  /** 退避上限 ms（默认 8000） */
  maxDelayMs?: number;
  /** 退避倍率（默认 2） */
  factor?: number;
  /** 退避抖动比例 0~1（默认 0.2；打散多任务同刻重试） */
  jitterRatio?: number;
  /** 外部取消（取消后立即抛出当前错误，不再重试） */
  signal?: AbortSignal;
  /** 自定义可重试判定（默认 isRetryableError） */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** 每次重试前的回调（日志/指标） */
  onRetry?: (info: RetryInfo) => void;
  /** sleep 注入（单测用；缺省 setTimeout） */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 指数退避时长：initialDelayMs × factor^(attempt-1)，钳到 maxDelayMs，并按 jitterRatio 抖动。
 * 导出便于单测与指标对齐。
 */
export function computeBackoffMs(
  attempt: number,
  opts: Pick<RetryOptions, 'initialDelayMs' | 'maxDelayMs' | 'factor' | 'jitterRatio'> = {},
): number {
  const base = Math.max(0, opts.initialDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const max = Math.max(base, opts.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS);
  const factor = Math.max(1, opts.factor ?? DEFAULT_RETRY_FACTOR);
  const raw = Math.min(max, base * factor ** Math.max(0, attempt - 1));
  const jitterRatio = Math.min(1, Math.max(0, opts.jitterRatio ?? 0.2));
  if (jitterRatio === 0) {
    return Math.round(raw);
  }
  const delta = raw * jitterRatio;
  return Math.round(Math.max(0, raw - delta + Math.random() * delta * 2));
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * 带指数退避的重试执行器：
 * - 仅对**可重试错误**重试（默认 isRetryableError），确定性失败立即抛出（不浪费配额与时间）；
 * - 最后一次尝试失败后原样抛出最后一次错误（保留原始堆栈与 cause 链）；
 * - `signal` 已中止 → 不再重试，立即抛出。
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? DEFAULT_RETRY_ATTEMPTS));
  const sleep = options.sleep ?? defaultSleep;
  const shouldRetry = options.shouldRetry ?? isRetryableError;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // 首次尝试照常执行（是否中止由 fn 自己感知）；后续尝试前若已中止则不再重试
    if (attempt > 1 && options.signal?.aborted) {
      throw lastErr ?? new Error('重试已取消（AbortSignal aborted）');
    }
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || options.signal?.aborted || !shouldRetry(err, attempt)) {
        throw err;
      }
      const delayMs = computeBackoffMs(attempt, options);
      options.onRetry?.({ attempt, attempts, delayMs, err });
      await sleep(delayMs);
    }
  }
  throw lastErr;
}
