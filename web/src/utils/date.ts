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
 * i18n 语言 → dayjs 全局 locale（01 §6）。
 * dayjs 默认 locale 恒为 'en'，不与 vue-i18n 联动，会导致中文界面下相对时间
 * 输出英文长串（"a few seconds ago"）撑破窄列布局，故在语言切换时显式同步。
 */
export function setDayjsLocale(lang: 'zh-CN' | 'en') {
  dayjs.locale(lang === 'zh-CN' ? 'zh-cn' : 'en')
}

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

/** 相对时间（03 §7：3 分钟前，用于会话/日志；locale 由 setDayjsLocale 全局同步） */
export function formatRelative(value: string | number | Date | undefined | null): string {
  if (!value) return '—'
  return dayjs(value).fromNow()
}

export { dayjs }
