import { describe, expect, it, beforeEach } from 'vitest';
import {
  BizException,
  createId,
  decodeCrockford,
  encodeCrockford,
  ID_PREFIX,
  initSnowflake,
  isIdWithPrefix,
  parseId,
  Snowflake,
} from '../src/index.js';

describe('snowflake id', () => {
  beforeEach(() => {
    initSnowflake(1n);
  });

  it('生成 {前缀}_{13位Crockford} 形态的 ID', () => {
    const id = createId(ID_PREFIX.task);
    expect(id).toMatch(/^task_[0-9A-HJ-NP-TV-Z]{13}$/);
    expect(isIdWithPrefix(id, 'task')).toBe(true);
    expect(isIdWithPrefix(id, 'lead')).toBe(false);
  });

  it('同毫秒内单调递增（after 游标语义）', () => {
    const fixed = Date.now();
    const sf = new Snowflake(1n, () => fixed);
    const values: bigint[] = [];
    for (let i = 0; i < 4096; i++) {
      values.push(sf.next());
    }
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThan(values[i - 1]!);
    }
  });

  it('字典序 = 时间序（定长编码）', () => {
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      ids.push(createId('tlog'));
    }
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });

  it('decode 还原时间戳/机器位/序列', () => {
    const now = 1_780_000_000_000; // 2026-06 附近
    initSnowflake(7n, () => now);
    const id = createId('task');
    const parts = parseId(id);
    expect(parts.prefix).toBe('task');
    expect(parts.machineId).toBe(7n);
    expect(parts.epochMs).toBe(BigInt(now));
  });

  it('时钟回拨 > 5ms 抛错拒发', () => {
    let current = 1_780_000_000_000;
    initSnowflake(1n, () => current);
    createId('task');
    current -= 10; // 回拨 10ms
    expect(() => createId('task')).toThrowError(BizException);
  });

  it('时钟回拨 < 5ms 自旋等待不抛错', () => {
    let dipped = false;
    const current = 1_780_000_000_000;
    const nowFn = (): number => {
      if (dipped) {
        dipped = false;
        return current - 3; // 回拨 3ms（< 5ms 阈值）
      }
      return current;
    };
    initSnowflake(1n, nowFn);
    createId('task'); // 基准 ts0
    dipped = true;
    const id2 = createId('task'); // 回拨检测 → 自旋追平 → seq+1
    expect(parseId(id2).sequence).toBe(1n);
  });

  it('非法前缀抛错', () => {
    expect(() => createId('bad_prefix')).toThrowError(BizException);
    expect(() => createId('1abc')).toThrowError(BizException);
  });

  it('Crockford 编解码往返', () => {
    for (const v of [0n, 1n, 31n, 32n, 2n ** 63n - 1n]) {
      expect(decodeCrockford(encodeCrockford(v))).toBe(v);
    }
  });
});
