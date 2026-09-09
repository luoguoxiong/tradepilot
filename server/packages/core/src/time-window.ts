/**
 * 发送窗口对齐与频控顺延（后端技术方案 04 §3.2 —— 唯一实现点）：
 *
 *   L = 该客户最近一次 outbound 邮件时间
 *   target      = max(当前 next_run_at, L + minTouchIntervalDays 天)
 *   next_run_at' = 对齐发送窗口(target, org.send_rules.sendWindow, org.timezone)
 *     当地 < 09:00 → 当日窗口起点；≥ 18:00 → 次日窗口起点；窗口内 → 保持
 *
 * Scheduler 频控预检与图内 schedule_next 均调用本文件函数，排期单一写入口。
 * 库层一律 UTC（后端技术方案 01 §6.4），时区换算集中于此。
 */

import { BizException } from './errors.js';

export interface SendWindow {
  /** 窗口起点（当地小时，含） */
  startHour: number;
  /** 窗口终点（当地小时，不含） */
  endHour: number;
}

/** 默认发送窗口 09:00–18:00（企业当地时间） */
export const DEFAULT_SEND_WINDOW: Readonly<SendWindow> = { startHour: 9, endHour: 18 };

export interface ZonedWallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const PART_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function getWallFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = PART_FORMATTER_CACHE.get(timeZone);
  if (!formatter) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone });
    } catch {
      throw new BizException(40001, `非法 IANA 时区: ${timeZone}`);
    }
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    PART_FORMATTER_CACHE.set(timeZone, formatter);
  }
  return formatter;
}

/** 将 UTC 时间映射到指定时区的墙钟时间（不含毫秒） */
export function getZonedWallTime(date: Date, timeZone: string): ZonedWallTime {
  const parts = getWallFormatter(timeZone).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((p) => p.type === type)?.value;
    const parsed = value === undefined ? NaN : Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
      throw new BizException(50001, `时区解析失败: ${timeZone}`);
    }
    return parsed;
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/**
 * org 时区墙钟日 key（M4 #6：外部配额按 org 时区日界精确轮换，06 §3）。
 * 输出 'yyyyMMdd'（如 20260908）——配额 Redis key 按此分片，org 当地零点自动进入新 key。
 */
export function zonedDayKey(date: Date, timeZone: string): string {
  const wall = getZonedWallTime(date, timeZone);
  const mm = String(wall.month).padStart(2, '0');
  const dd = String(wall.day).padStart(2, '0');
  return `${wall.year}${mm}${dd}`;
}

function getTimeZoneOffsetMs(utcMs: number, timeZone: string): number {
  const wall = getZonedWallTime(new Date(utcMs), timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** 指定时区的墙钟时间 → UTC Date（两遍法，处理 DST 边界） */
export function zonedWallTimeToUtc(wall: ZonedWallTime, timeZone: string): Date {
  const guessUtcMs = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  let utcMs = guessUtcMs - getTimeZoneOffsetMs(guessUtcMs, timeZone);
  utcMs = guessUtcMs - getTimeZoneOffsetMs(utcMs, timeZone);
  return new Date(utcMs);
}

/** 墙钟日期整体偏移 N 天（交给 Date.UTC 进位处理月末/闰年） */
function shiftWallDays(wall: ZonedWallTime, days: number): ZonedWallTime {
  const base = Date.UTC(wall.year, wall.month - 1, wall.day + days);
  const shifted = new Date(base);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: wall.hour,
    minute: wall.minute,
    second: wall.second,
  };
}

/**
 * 对齐发送窗口（04 §3.2）：
 * - 当地小时 < startHour → 当日窗口起点；
 * - 当地小时 ≥ endHour → 次日窗口起点；
 * - 窗口内 → 保持 target 原值。
 */
export function alignToSendWindow(
  target: Date,
  timeZone: string,
  window: SendWindow = DEFAULT_SEND_WINDOW,
): Date {
  const wall = getZonedWallTime(target, timeZone);

  if (wall.hour < window.startHour) {
    return zonedWallTimeToUtc({ ...wall, hour: window.startHour, minute: 0, second: 0 }, timeZone);
  }
  if (wall.hour >= window.endHour) {
    const nextDay = shiftWallDays(wall, 1);
    return zonedWallTimeToUtc(
      { ...nextDay, hour: window.startHour, minute: 0, second: 0 },
      timeZone,
    );
  }
  return target;
}

export interface FrequencyDeferralInput {
  /** 当前时间 */
  now: Date;
  /** 任务当前 next_run_at */
  nextRunAt: Date;
  /** 该客户最近一次 outbound 邮件时间（无则 null） */
  lastOutboundAt: Date | null;
  /** 最小触达间隔天数（org.send_rules.minTouchIntervalDays，默认 3） */
  minTouchIntervalDays: number;
  /** 企业 IANA 时区（org.timezone） */
  timeZone: string;
  /** 发送窗口（org.send_rules.sendWindow，缺省 09–18） */
  window?: SendWindow;
}

/**
 * 频控顺延目标公式（P1-4 收口口径）：
 * 候选 = max(当前 next_run_at, L + minTouchIntervalDays 天)，再对齐发送窗口。
 */
export function computeDeferredNextRunAt(input: FrequencyDeferralInput): Date {
  // now 仅作为调用方语义基准保留在入参中；公式目标 = max(next_run_at, L+interval)，与 now 无关
  const { nextRunAt, lastOutboundAt, minTouchIntervalDays, timeZone, window } = input;

  if (minTouchIntervalDays < 0) {
    throw new BizException(40001, `minTouchIntervalDays 不能为负: ${minTouchIntervalDays}`);
  }

  // L + minTouchIntervalDays 天：以「绝对毫秒」推进间隔（间隔语义为时长而非墙钟日）
  const candidateFromInterval =
    lastOutboundAt === null
      ? new Date(0)
      : new Date(lastOutboundAt.getTime() + minTouchIntervalDays * 86_400_000);

  const target =
    nextRunAt.getTime() >= candidateFromInterval.getTime() ? nextRunAt : candidateFromInterval;

  if (window !== undefined) {
    return alignToSendWindow(target, timeZone, window);
  }
  return alignToSendWindow(target, timeZone);
}
