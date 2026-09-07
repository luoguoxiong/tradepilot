import Decimal from 'decimal.js'

/**
 * 金额展示（03 §7）：字符串/数字 → 本地化货币格式，币种缺省 USD。
 * 展示用本函数；任何金额计算必须走 decimal.js（01 §6 禁 float 运算）。
 */
export function formatMoney(amount: string | number | null | undefined, currency = 'USD'): string {
  if (amount === null || amount === undefined || amount === '') return '—'
  let value: Decimal
  try {
    value = new Decimal(String(amount))
  } catch {
    return '—'
  }
  if (value.isNaN()) return '—'
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).format(value.toNumber())
}

/** 金额计算入口（decimal.js 统一封装，防止散落 new Decimal） */
export function toDecimal(amount: string | number): Decimal {
  return new Decimal(String(amount))
}

/** 评分/置信度展示（03 §7）：0.92 → 92% */
export function formatPercent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return `${(value * 100).toFixed(digits)}%`
}

/** 邮箱账号脱敏（16 FR-05：sales@company.com → sales***@company.com） */
export function maskEmail(account: string | undefined | null): string {
  if (!account) return '—'
  const at = account.indexOf('@')
  if (at <= 0) return account
  const local = account.slice(0, at)
  const visible = local.slice(0, Math.min(5, local.length))
  return `${visible}***${account.slice(at)}`
}
