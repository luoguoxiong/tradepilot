import { describe, expect, it } from 'vitest';
import {
  alignToSendWindow,
  computeDeferredNextRunAt,
  DEFAULT_SEND_WINDOW,
  zonedDayKey,
  zonedWallTimeToUtc,
} from '../src/index.js';

describe('zonedDayKey（org 时区墙钟日 key，M4 #6 配额日界）', () => {
  it('同一 UTC 时刻在不同时区产出不同当地日（Shanghai UTC+8 vs UTC）', () => {
    const t = new Date('2026-09-08T16:30:00Z'); // Shanghai 09-09 00:30 / UTC 09-08 16:30
    expect(zonedDayKey(t, 'Asia/Shanghai')).toBe('20260909');
    expect(zonedDayKey(t, 'UTC')).toBe('20260908');
  });

  it('格式为 yyyyMMdd（补零）', () => {
    const t = new Date('2026-01-03T00:00:00Z');
    expect(zonedDayKey(t, 'UTC')).toBe('20260103');
  });
});

describe('alignToSendWindow（Asia/Shanghai，UTC+8）', () => {
  const TZ = 'Asia/Shanghai';

  it('窗口内保持原值（10:00 当地）', () => {
    const target = new Date('2026-09-07T02:00:00Z'); // 10:00 当地
    expect(alignToSendWindow(target, TZ).getTime()).toBe(target.getTime());
  });

  it('窗口起点整点保持（09:00 当地）', () => {
    const target = new Date('2026-09-07T01:00:00Z'); // 09:00 当地
    expect(alignToSendWindow(target, TZ).getTime()).toBe(target.getTime());
  });

  it('当地 < 09:00 → 当日窗口起点（08:30 → 09:00）', () => {
    const target = new Date('2026-09-07T00:30:00Z'); // 08:30 当地
    expect(alignToSendWindow(target, TZ).toISOString()).toBe('2026-09-07T01:00:00.000Z');
  });

  it('当地 ≥ 18:00 → 次日窗口起点（18:00 整 → 次日 09:00）', () => {
    const target = new Date('2026-09-07T10:00:00Z'); // 18:00 当地
    expect(alignToSendWindow(target, TZ).toISOString()).toBe('2026-09-08T01:00:00.000Z');
  });

  it('当地 20:45 → 次日窗口起点', () => {
    const target = new Date('2026-09-07T12:45:00Z'); // 20:45 当地
    expect(alignToSendWindow(target, TZ).toISOString()).toBe('2026-09-08T01:00:00.000Z');
  });

  it('月末进位：当地 7-31 20:00 → 8-01 09:00', () => {
    const target = new Date('2026-07-31T12:00:00Z'); // 20:00 当地
    expect(alignToSendWindow(target, TZ).toISOString()).toBe('2026-08-01T01:00:00.000Z');
  });
});

describe('alignToSendWindow（America/New_York，DST）', () => {
  const TZ = 'America/New_York';

  it('夏令时（EDT=UTC-4）：18:00 当地 → 次日 09:00 EDT（13:00Z）', () => {
    const target = new Date('2026-07-01T22:00:00Z'); // 18:00 EDT
    expect(alignToSendWindow(target, TZ).toISOString()).toBe('2026-07-02T13:00:00.000Z');
  });

  it('冬令时（EST=UTC-5）：18:30 当地 → 次日 09:00 EST（14:00Z）', () => {
    const target = new Date('2026-01-15T23:30:00Z'); // 18:30 EST
    expect(alignToSendWindow(target, TZ).toISOString()).toBe('2026-01-16T14:00:00.000Z');
  });

  it('自定义窗口（如 08–17）', () => {
    const target = new Date('2026-09-07T10:00:00Z'); // 18:00 当地（上海）
    const aligned = alignToSendWindow(target, 'Asia/Shanghai', { startHour: 8, endHour: 17 });
    expect(aligned.toISOString()).toBe('2026-09-08T00:00:00.000Z');
    expect(DEFAULT_SEND_WINDOW).toEqual({ startHour: 9, endHour: 18 });
  });
});

describe('zonedWallTimeToUtc', () => {
  it('墙钟 → UTC 往返一致', () => {
    const utc = new Date('2026-09-07T02:34:56Z');
    const wall = { year: 2026, month: 9, day: 7, hour: 10, minute: 34, second: 56 };
    expect(zonedWallTimeToUtc(wall, 'Asia/Shanghai').getTime()).toBe(utc.getTime());
  });
});

describe('computeDeferredNextRunAt（频控顺延公式）', () => {
  const TZ = 'Asia/Shanghai';

  it('候选 = max(next_run_at, L + interval)，再对齐窗口', () => {
    // L = 09-06 18:00 当地；+3 天 → 09-09 18:00 当地 = 10:00Z（≥18:00 → 顺延次日 09:00）
    const result = computeDeferredNextRunAt({
      now: new Date('2026-09-06T02:00:00Z'),
      nextRunAt: new Date('2026-09-07T01:00:00Z'),
      lastOutboundAt: new Date('2026-09-06T10:00:00Z'),
      minTouchIntervalDays: 3,
      timeZone: TZ,
    });
    expect(result.toISOString()).toBe('2026-09-10T01:00:00.000Z');
  });

  it('next_run_at 更晚且在窗口内 → 保持', () => {
    const result = computeDeferredNextRunAt({
      now: new Date('2026-09-06T02:00:00Z'),
      nextRunAt: new Date('2026-09-12T05:00:00Z'), // 13:00 当地，窗口内
      lastOutboundAt: new Date('2026-09-06T10:00:00Z'),
      minTouchIntervalDays: 3,
      timeZone: TZ,
    });
    expect(result.toISOString()).toBe('2026-09-12T05:00:00.000Z');
  });

  it('无 outbound 记录 → 以 next_run_at 对齐窗口', () => {
    const result = computeDeferredNextRunAt({
      now: new Date('2026-09-06T02:00:00Z'),
      nextRunAt: new Date('2026-09-07T00:30:00Z'), // 08:30 当地
      lastOutboundAt: null,
      minTouchIntervalDays: 3,
      timeZone: TZ,
    });
    expect(result.toISOString()).toBe('2026-09-07T01:00:00.000Z');
  });

  it('间隔落在窗口内 → 顺延到 L + interval', () => {
    const result = computeDeferredNextRunAt({
      now: new Date('2026-09-06T02:00:00Z'),
      nextRunAt: new Date('2026-09-07T01:00:00Z'),
      lastOutboundAt: new Date('2026-09-09T01:30:00Z'), // +3d = 09-12 09:30 当地（窗口内）
      minTouchIntervalDays: 3,
      timeZone: TZ,
    });
    expect(result.toISOString()).toBe('2026-09-12T01:30:00.000Z');
  });
});
