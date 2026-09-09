import { BizException } from './errors.js';

/**
 * ID 生成（后端技术方案 02 §9）：
 * - 格式：`{前缀}_{雪花64bit-Crockford}`，前缀对照 ER §2.2 / 接口总览 §2.4；
 * - 雪花：41bit 毫秒（自定义纪元）+ 10bit 机器位（WORKER_INDEX）+ 12bit 序列；
 * - 单机单调、同毫秒内递增，保证 `after={logId}` 游标语义；
 * - Crockford Base32 固定 13 位，字典序 = 时间序。
 */

/** 自定义纪元：2026-01-01T00:00:00Z */
const EPOCH_MS = 1_767_225_600_000n;

const TIMESTAMP_BITS = 41n;
const MACHINE_BITS = 10n;
const SEQUENCE_BITS = 12n;

const MAX_TIMESTAMP = (1n << TIMESTAMP_BITS) - 1n; // 41bit
const MAX_MACHINE = (1n << MACHINE_BITS) - 1n; // 10bit
const MAX_SEQUENCE = (1n << SEQUENCE_BITS) - 1n; // 12bit

const MACHINE_SHIFT = SEQUENCE_BITS;
const TIMESTAMP_SHIFT = MACHINE_BITS + SEQUENCE_BITS;

/** Crockford Base32（不含 I / L / O / U） */
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODED_LENGTH = 13; // 32^13 > 2^63，定长保证字典序可比

/** 时钟回拨容忍阈值（02 §9）：> 5ms 拒发，< 5ms 自旋等待 */
const CLOCK_ROLLBACK_TOLERANCE_MS = 5;

export interface SnowflakeParts {
  /** 自定义纪元以来的毫秒数 */
  timestampMs: bigint;
  machineId: bigint;
  sequence: bigint;
  /** 绝对 UTC 毫秒时间戳 */
  epochMs: bigint;
}

export class Snowflake {
  private lastTimestampMs = -1n;
  private sequence = 0n;

  constructor(
    private readonly machineId: bigint,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (machineId < 0n || machineId > MAX_MACHINE) {
      throw new Error(`machineId 必须在 0~${MAX_MACHINE} 之间，收到 ${machineId}`);
    }
  }

  next(): bigint {
    let timestampMs = BigInt(Math.trunc(this.now())) - EPOCH_MS;

    if (timestampMs < 0n) {
      timestampMs = 0n;
    }

    // 时钟回拨保护
    if (timestampMs < this.lastTimestampMs) {
      const rollbackMs = Number(this.lastTimestampMs - timestampMs);
      if (rollbackMs > CLOCK_ROLLBACK_TOLERANCE_MS) {
        throw new BizException(50001, `时钟回拨 ${rollbackMs}ms，拒绝生成 ID（防日志游标乱序）`);
      }
      // < 5ms：自旋等待追上 lastTimestampMs
      while (BigInt(Math.trunc(this.now())) - EPOCH_MS < this.lastTimestampMs) {
        // busy-wait
      }
      timestampMs = this.lastTimestampMs;
    }

    if (timestampMs === this.lastTimestampMs) {
      this.sequence = (this.sequence + 1n) & MAX_SEQUENCE;
      if (this.sequence === 0n) {
        // 同毫秒序列耗尽，自旋至下一毫秒
        while (BigInt(Math.trunc(this.now())) - EPOCH_MS <= this.lastTimestampMs) {
          // busy-wait
        }
        timestampMs = BigInt(Math.trunc(this.now())) - EPOCH_MS;
      }
    } else {
      this.sequence = 0n;
    }

    this.lastTimestampMs = timestampMs;

    return (timestampMs << TIMESTAMP_SHIFT) | (this.machineId << MACHINE_SHIFT) | this.sequence;
  }

  static decode(value: bigint): SnowflakeParts {
    const timestampMs = (value >> TIMESTAMP_SHIFT) & MAX_TIMESTAMP;
    const machineId = (value >> MACHINE_SHIFT) & MAX_MACHINE;
    const sequence = value & MAX_SEQUENCE;
    return { timestampMs, machineId, sequence, epochMs: timestampMs + EPOCH_MS };
  }
}

/** 默认全局实例；机器位取 WORKER_INDEX 环境变量（缺省 1） */
let defaultSnowflake: Snowflake | null = null;

function getDefaultSnowflake(): Snowflake {
  if (defaultSnowflake === null) {
    const raw = Number.parseInt(process.env['WORKER_INDEX'] ?? '1', 10);
    const machineId = Number.isFinite(raw)
      ? BigInt(Math.max(0, Math.min(raw, Number(MAX_MACHINE))))
      : 1n;
    defaultSnowflake = new Snowflake(machineId);
  }
  return defaultSnowflake;
}

/** 测试与多进程初始化用：替换默认实例 */
export function initSnowflake(machineId: bigint, now?: () => number): void {
  defaultSnowflake = new Snowflake(machineId, now);
}

/** 64bit 雪花 → Crockford Base32 定长字符串 */
export function encodeCrockford(value: bigint): string {
  if (value < 0n) {
    throw new Error('仅支持非负整数');
  }
  let rest = value;
  let out = '';
  while (rest > 0n) {
    out = CROCKFORD_ALPHABET[Number(rest % 32n)]! + out;
    rest /= 32n;
  }
  return out.padStart(ENCODED_LENGTH, '0');
}

/** Crockford Base32 → bigint（容忍小写与易混淆字符 I/L→1、O→0） */
export function decodeCrockford(input: string): bigint {
  let result = 0n;
  for (const raw of input.toUpperCase()) {
    let index: number;
    if (raw === 'I' || raw === 'L') {
      index = 1;
    } else if (raw === 'O') {
      index = 0;
    } else {
      index = CROCKFORD_ALPHABET.indexOf(raw);
      if (index < 0) {
        throw new BizException(40001, `非法 Crockford 字符: ${raw}`);
      }
    }
    result = result * 32n + BigInt(index);
  }
  return result;
}

/** ID 前缀对照（ER §2.2 / 接口总览 §2.4，02 §9 补充 org/usr/tlog） */
export const ID_PREFIX = {
  org: 'org',
  user: 'usr',
  aiEmployee: 'emp',
  task: 'task',
  taskLog: 'tlog',
  taskStep: 'step',
  lead: 'lead',
  customer: 'cus',
  contact: 'con',
  conversation: 'conv',
  message: 'msg',
  product: 'prod',
  quotation: 'quote',
  salesOrder: 'order',
  knowledgeDocument: 'doc',
  approval: 'appr',
  followUpStrategy: 'strat',
  followUpTask: 'ftask',
  report: 'rpt',
  trace: 'trc',
  /** 通知设置行（notification_setting） */
  notificationSetting: 'ntf',
  /** 站内通知收件箱行（notification，M5-A2 增补表） */
  notification: 'ntfn',
} as const;

export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

const PREFIX_PATTERN = /^[a-z][a-z0-9]*$/;

/**
 * 生成 `{前缀}_{Crockford雪花}` 形态的资源 ID。
 * 前缀须为小写字母开头的字母数字（禁止下划线，`_` 为分隔符）。
 */
export function createId(prefix: IdPrefix | (string & {})): string {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new BizException(50001, `非法 ID 前缀: ${prefix}`);
  }
  return `${prefix}_${encodeCrockford(getDefaultSnowflake().next())}`;
}

/** 校验 ID 形态是否属于指定前缀（防注入式枚举，02 §7） */
export function isIdWithPrefix(id: string, prefix: string): boolean {
  const re = new RegExp(`^${prefix}_[0-9A-HJ-NP-TV-Z]{${ENCODED_LENGTH}}$`);
  return re.test(id);
}

/** 解析 ID 中的雪花成分（调试/游标换算用） */
export function parseId(id: string): SnowflakeParts & { prefix: string } {
  const separatorIndex = id.indexOf('_');
  if (separatorIndex <= 0) {
    throw new BizException(40001, `非法 ID: ${id}`);
  }
  const prefix = id.slice(0, separatorIndex);
  const body = id.slice(separatorIndex + 1);
  return { prefix, ...Snowflake.decode(decodeCrockford(body)) };
}
