import { hostname } from 'node:os';
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

  /** 跨毫秒重置时回到的序列起点，见构造函数 `initialSequence` 说明 */
  private readonly sequenceOffset: bigint;

  constructor(
    private readonly machineId: bigint,
    private readonly now: () => number = () => Date.now(),
    /**
     * 序列起点：默认 0（测试与显式 `initSnowflake` 保持确定性）。
     * 默认全局实例取随机值，且该偏移在跨毫秒重置时**持续生效**——仅在构造时赋一次
     * 是不够的，`next()` 每次跨毫秒都会把序列归零。
     */
    initialSequence: bigint = 0n,
  ) {
    this.sequenceOffset = initialSequence & MAX_SEQUENCE;
    this.sequence = this.sequenceOffset;
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
      if (this.sequence === this.sequenceOffset) {
        // 同毫秒序列耗尽（绕回起点），自旋至下一毫秒
        while (BigInt(Math.trunc(this.now())) - EPOCH_MS <= this.lastTimestampMs) {
          // busy-wait
        }
        timestampMs = BigInt(Math.trunc(this.now())) - EPOCH_MS;
      }
    } else {
      this.sequence = this.sequenceOffset;
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

/** 默认全局实例；机器位取 WORKER_INDEX 环境变量（缺省按进程派生） */
let defaultSnowflake: Snowflake | null = null;

/**
 * 未显式配置 WORKER_INDEX 时按「主机 + 进程」派生机器位（02 §9 的 10bit）。
 *
 * 背景：此前缺省值固定为 1，导致同一毫秒内不同进程（多实例 API / worker / 并行测试
 * worker）会以完全相同的 machineId + sequence=0 生成**同一条 ID**，实测 4 进程并发
 * 有 3 条完全重复，直接触发主键 23505。显式配置 WORKER_INDEX 时仍严格沿用该值，
 * 保证运维可预期的分片语义。
 */
function deriveMachineId(): bigint {
  const seed = `${hostname()}:${process.pid}`;
  let hash = 2_166_136_261n; // FNV-1a 32bit offset basis
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash ^ BigInt(seed.charCodeAt(i))) * 16_777_619n;
  }
  return (hash ^ (hash >> 32n)) & MAX_MACHINE;
}

function getDefaultSnowflake(): Snowflake {
  if (defaultSnowflake === null) {
    const rawEnv = process.env['WORKER_INDEX'];
    const raw = rawEnv === undefined || rawEnv === '' ? Number.NaN : Number.parseInt(rawEnv, 10);
    const machineId = Number.isFinite(raw)
      ? BigInt(Math.max(0, Math.min(raw, Number(MAX_MACHINE))))
      : deriveMachineId();
    // 序列起点一律随机：即便显式配置了 WORKER_INDEX，同一份配置（如 .env 的 WORKER_INDEX=1）
    // 也可能被 api 与 worker 多个进程共用；随机起点让「同机器位 + 同毫秒」的碰撞概率
    // 从必然降为 1/4096，且不破坏单进程内的单调递增语义。
    defaultSnowflake = new Snowflake(
      machineId,
      undefined,
      BigInt(Math.floor(Math.random() * Number(MAX_SEQUENCE + 1n))),
    );
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
  /** 销售订单明细行（sales_order_item，10 §3） */
  salesOrderItem: 'oitem',
  /** 订单进度流水（order_progress_log，10 FR-02） */
  orderProgressLog: 'oplog',
  /** 订单风险洞察（order_risk_insight，10 FR-04） */
  orderRiskInsight: 'orisk',
  knowledgeDocument: 'doc',
  approval: 'appr',
  followUpStrategy: 'strat',
  followUpTask: 'ftask',
  report: 'rpt',
  /** AI 发现·机会/风险（ai_discovery，ER 00 §2.2 / 13 §3.2） */
  discovery: 'disc',
  trace: 'trc',
  /** 通知设置行（notification_setting） */
  notificationSetting: 'ntf',
  /** 站内通知收件箱行（notification，M5-A2 增补表） */
  notification: 'ntfn',
  /** 开放 API 密钥（api_key，ER 01 §2.9） */
  apiKey: 'key',
  /** 出站 Webhook 订阅（webhook，ER 01 §2.10） */
  webhook: 'hook',
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
