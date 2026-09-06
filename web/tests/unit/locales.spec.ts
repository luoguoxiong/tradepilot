import { describe, expect, it } from 'vitest'

import en from '@/locales/en'
import zhCN from '@/locales/zh-CN'

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return value && typeof value === 'object'
      ? flattenKeys(value as Record<string, unknown>, path)
      : [path]
  })
}

describe('locales', () => {
  it('zh-CN 与 en 的 key 集合完全一致（i18n key 全覆盖，01 §6）', () => {
    expect(flattenKeys(zhCN).sort()).toEqual(flattenKeys(en).sort())
  })
})
