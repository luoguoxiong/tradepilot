import { describe, expect, it } from 'vitest'
import type { RouteLocationNormalizedLoaded } from 'vue-router'

import { KEEP_ALIVE_INCLUDE, keepAliveKey } from '@/layouts/default-layout/keep-alive'

/**
 * keep-alive 单测（排期 M4-5 / 02 §6）：
 * ① include 白名单覆盖高频列表页（CRM / 发现列表 / 审批），客户 360° 不在内；
 * ② 缓存 key 含 query 页签参数，同一 path 不同 tab 各自独立缓存。
 */

function route(path: string, query: Record<string, unknown> = {}): RouteLocationNormalizedLoaded {
  return { path, query } as RouteLocationNormalizedLoaded
}

describe('keep-alive（02 §6）', () => {
  it('include 白名单 = CRM / 发现列表 / 审批（360° 不入保活）', () => {
    expect(KEEP_ALIVE_INCLUDE).toEqual(['CrmView', 'LeadDiscoverView', 'ApprovalsView'])
  })

  it('无页签 query → key 为 path（单实例，页签为组件内部态）', () => {
    expect(keepAliveKey(route('/crm'))).toBe('/crm')
    expect(keepAliveKey(route('/lead-gen/leads'))).toBe('/lead-gen/leads')
  })

  it('含字符串 tab query → key = path + ?tab=（各自独立缓存，返回恢复筛选态）', () => {
    expect(keepAliveKey(route('/customers/c1', { tab: 'overview' }))).toBe(
      '/customers/c1?tab=overview',
    )
    expect(keepAliveKey(route('/customers/c1', { tab: 'contacts' }))).toBe(
      '/customers/c1?tab=contacts',
    )
  })

  it('tab 非字符串（数组等）→ 回退 path', () => {
    expect(keepAliveKey(route('/crm', { tab: ['potential', 'formal'] }))).toBe('/crm')
  })
})
