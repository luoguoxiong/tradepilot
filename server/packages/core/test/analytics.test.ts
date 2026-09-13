import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_CALIBER_NOTE,
  ANALYTICS_METRIC,
  ANALYTICS_METRIC_LIST,
  PROMOTED_INQUIRY_WINDOW_DAYS,
  PROMOTED_INQUIRY_WINDOW_MS,
  SAVED_HOURS_BASELINE_MINUTES,
  STAT_DIMENSION_ALL,
  computeSavedHours,
  isWithinAttributionWindow,
  pickLastTouch,
  zonedDayRangeUtc,
} from '../src/index.js';

describe('分析指标口径常量（P1-X-42）', () => {
  it('维度兜底值与 14 天归因窗口', () => {
    expect(STAT_DIMENSION_ALL).toBe('ALL');
    expect(PROMOTED_INQUIRY_WINDOW_DAYS).toBe(14);
    expect(PROMOTED_INQUIRY_WINDOW_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it('savedHours 人工基准：获客 10 / 邮件 15 / 跟进 5（分钟）', () => {
    expect(SAVED_HOURS_BASELINE_MINUTES).toEqual({ foundCustomer: 10, email: 15, followUp: 5 });
  });

  it('caliberNote 明确标注估算与归因口径', () => {
    expect(ANALYTICS_CALIBER_NOTE).toContain('估算');
    expect(ANALYTICS_CALIBER_NOTE).toContain('10min/客户');
    expect(ANALYTICS_CALIBER_NOTE).toContain('14 天');
  });

  it('下钻 metric 枚举与接口 15 §3.4 一致', () => {
    expect(ANALYTICS_METRIC_LIST).toEqual([
      'new_customers',
      'inquiries',
      'new_quotes',
      'deals_closed',
      'found_customers',
      'replied_emails',
      'saved_hours',
      'promoted_inquiries',
    ]);
    expect(ANALYTICS_METRIC.SAVED_HOURS).toBe('saved_hours');
  });
});

describe('computeSavedHours（估算口径，P1-X-42）', () => {
  it('按动作数 × 基准分钟 / 60 估算，保留 1 位小数', () => {
    // 10*10 + 15*4 + 5*2 = 100+60+10 = 170min = 2.8333h → 2.8
    expect(computeSavedHours({ foundCustomers: 10, repliedEmails: 4, followUpActions: 2 })).toBe(
      2.8,
    );
  });

  it('全零返回 0', () => {
    expect(computeSavedHours({ foundCustomers: 0, repliedEmails: 0, followUpActions: 0 })).toBe(0);
  });

  it('四舍五入到小数点后 1 位', () => {
    // 1 客户 = 10min = 0.1666h → 0.2；3 邮件 = 45min = 0.75h → 0.8
    expect(computeSavedHours({ foundCustomers: 1, repliedEmails: 0, followUpActions: 0 })).toBe(
      0.2,
    );
    expect(computeSavedHours({ foundCustomers: 0, repliedEmails: 3, followUpActions: 0 })).toBe(
      0.8,
    );
  });
});

describe('promotedInquiries 归因（14 天窗口 + 最后触点，P1-X-43）', () => {
  const inquiryAt = new Date('2026-09-10T12:00:00Z');
  const day = 24 * 60 * 60 * 1000;

  it('窗口判定含边界：0 天（同时刻）与恰好 14 天命中，超 1 毫秒不命中', () => {
    expect(isWithinAttributionWindow(inquiryAt, inquiryAt)).toBe(true);
    expect(isWithinAttributionWindow(new Date(inquiryAt.getTime() - 14 * day), inquiryAt)).toBe(
      true,
    );
    expect(isWithinAttributionWindow(new Date(inquiryAt.getTime() - 14 * day - 1), inquiryAt)).toBe(
      false,
    );
  });

  it('未来触点（晚于询盘）不计入归因', () => {
    expect(isWithinAttributionWindow(new Date(inquiryAt.getTime() + 1), inquiryAt)).toBe(false);
  });

  it('最后触点取窗口内时间最大者', () => {
    const best = pickLastTouch(
      [
        { employeeId: 'emp_a', at: new Date(inquiryAt.getTime() - 20 * day) }, // 窗口外
        { employeeId: 'emp_b', at: new Date(inquiryAt.getTime() - 10 * day) },
        { employeeId: 'emp_c', at: new Date(inquiryAt.getTime() - 3 * day) },
      ],
      inquiryAt,
    );
    expect(best?.employeeId).toBe('emp_c');
  });

  it('窗口内无触点返回 null（不产出无证据结论）', () => {
    expect(
      pickLastTouch(
        [{ employeeId: 'emp_a', at: new Date(inquiryAt.getTime() - 30 * day) }],
        inquiryAt,
      ),
    ).toBeNull();
    expect(pickLastTouch([], inquiryAt)).toBeNull();
  });
});

describe('分析 ETL 当地日历日切分（P1-X-40）', () => {
  it('按 org 时区回退当地日（Asia/Shanghai UTC+8）', () => {
    const now = new Date('2026-09-13T02:00:00Z'); // 当地 09-13 10:00
    const today = zonedDayRangeUtc(now, 'Asia/Shanghai', 0);
    expect(today.statDate).toBe('2026-09-13');
    expect(today.start.toISOString()).toBe('2026-09-12T16:00:00.000Z');
    expect(today.end.toISOString()).toBe('2026-09-13T16:00:00.000Z');

    const yesterday = zonedDayRangeUtc(now, 'Asia/Shanghai', 1);
    expect(yesterday.statDate).toBe('2026-09-12');
    expect(yesterday.start.toISOString()).toBe('2026-09-11T16:00:00.000Z');
    expect(yesterday.end.toISOString()).toBe('2026-09-12T16:00:00.000Z');
  });

  it('DST 切换日区间为 23h（America/New_York 2026-03-08 起夏令时）', () => {
    const range = zonedDayRangeUtc(new Date('2026-03-08T12:00:00Z'), 'America/New_York', 0);
    expect(range.statDate).toBe('2026-03-08');
    expect(range.start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(range.end.getTime() - range.start.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it('daysAgo 为负时抛错', () => {
    expect(() => zonedDayRangeUtc(new Date(), 'UTC', -1)).toThrow();
  });
});
