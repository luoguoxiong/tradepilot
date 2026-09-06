import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import timezone from 'dayjs/plugin/timezone'
import utc from 'dayjs/plugin/utc'

import 'dayjs/locale/zh-cn'

dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.extend(relativeTime)

/** org 默认时区（16 v0.4：IANA，默认 Asia/Shanghai） */
export const DEFAULT_TIMEZONE = 'Asia/Shanghai'

/**
 * 时间展示（03 §7）：DB 存 UTC，展示统一转企业时区 `dayjs.utc(x).tz(org.timezone)`。
 * 「今日待执行」按企业当地日历日分组（工程约定）。
 */
export function inOrgTz(
  value: string | number | Date | undefined | null,
  timezone = DEFAULT_TIMEZONE,
) {
  if (!value) return null
  return dayjs.utc(value).tz(timezone)
}

/** 企业时区格式化，默认 YYYY-MM-DD HH:mm */
export function formatInOrgTz(
  value: string | number | Date | undefined | null,
  timezone = DEFAULT_TIMEZONE,
  format = 'YYYY-MM-DD HH:mm',
): string {
  const d = inOrgTz(value, timezone)
  return d ? d.format(format) : '—'
}

/** 相对时间（03 §7：3 分钟前，用于会话/日志） */
export function formatRelative(value: string | number | Date | undefined | null): string {
  if (!value) return '—'
  return dayjs(value)
    .locale(dayjs.locale() === 'zh-cn' ? 'zh-cn' : 'en')
    .fromNow()
}

export { dayjs }
