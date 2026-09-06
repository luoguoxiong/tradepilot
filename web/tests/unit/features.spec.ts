import { describe, expect, it } from 'vitest'

import { features } from '@/features'

describe('features（编译期特性开关，02 §5.1）', () => {
  it('默认 p0 档位下所有 P1 模块关闭', () => {
    expect(Object.values(features).every(Boolean)).toBe(false)
  })

  it('包含全部 6 个 P1 模块 key', () => {
    expect(Object.keys(features).sort()).toEqual(
      ['dataCenter', 'manager', 'orders', 'products', 'quotes', 'taskCenter'].sort(),
    )
  })
})
