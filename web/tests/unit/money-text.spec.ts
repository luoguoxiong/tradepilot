import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import MoneyText from '@/components/business/MoneyText.vue'

/**
 * MoneyText 单测（排期 M4-4 / 04 §2.2）：
 * amount 字符串 + currency → 本地化格式；空值 / 非法值渲染「—」；防 float（字符串十进制直出）。
 */

function mountText(amount: string | number | null | undefined, currency?: string) {
  return mount(MoneyText, {
    props: { amount, ...(currency ? { currency } : {}) },
  })
}

describe('MoneyText', () => {
  it('字符串十进制金额渲染本地化货币格式（缺省 USD）', () => {
    const wrapper = mountText('12500.00')
    expect(wrapper.text()).toBe('US$12,500.00')
  })

  it('显式 currency 覆盖缺省币种（EUR）', () => {
    const wrapper = mountText('999.9', 'EUR')
    expect(wrapper.text()).toContain('999.90')
    expect(wrapper.text()).toContain('€')
  })

  it('字符串十进制防 float 精度（0.1 类陷阱值直出）', () => {
    const wrapper = mountText('0.1')
    expect(wrapper.text()).toBe('US$0.10')
  })

  it('null / undefined / 空串渲染「—」', () => {
    expect(mountText(null).text()).toBe('—')
    expect(mountText(undefined).text()).toBe('—')
    expect(mountText('').text()).toBe('—')
  })

  it('非法金额（NaN）渲染「—」', () => {
    expect(mountText('abc').text()).toBe('—')
  })

  it('负数金额保留符号', () => {
    expect(mountText('-1200.5').text()).toBe('-US$1,200.50')
  })
})
