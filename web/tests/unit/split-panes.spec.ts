import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import SplitPanes from '@/components/common/SplitPanes.vue'

/**
 * SplitPanes 单测（M5-B2 / 06 §2 三栏工作台）：
 * - 按占比渲染 pane + 分隔条数量 = n-1，flexBasis 应用百分比；
 * - 拖拽（pointerdown → move → up）：位移换算 + min 夹取 + 非受控更新/受控 emit；
 * - 双击分隔条复位该对初始占比；
 * - storageKey 持久化：恢复 / 损坏 JSON 与长度不符回退 initial。
 */

const RECT = {
  x: 0,
  y: 0,
  width: 1000,
  height: 500,
  top: 0,
  left: 0,
  right: 1000,
  bottom: 500,
  toJSON: () => ({}),
} as DOMRect

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  // jsdom 无布局：桩定容器矩形与 pointer capture，拖拽换算可控
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(RECT)
  Element.prototype.setPointerCapture = vi.fn()
})

/** 拖拽序列：pointerdown 捕获 → move 计算 → up 持久化（顺序 await） */
async function dragDivider(
  wrapper: ReturnType<typeof mount>,
  clientX: number,
): Promise<void> {
  const divider = wrapper.find('.split-panes__divider')
  await divider.trigger('pointerdown', { pointerId: 1 })
  await divider.trigger('pointermove', { clientX })
  await divider.trigger('pointerup')
}

describe('SplitPanes 渲染', () => {
  it('按 initial 渲染 pane 槽位 + 分隔条 = n-1，flexBasis 应用百分比', () => {
    const wrapper = mount(SplitPanes, {
      props: { initial: [30, 70] },
      slots: { 'pane-0': '<div class="a">A</div>', 'pane-1': '<div class="b">B</div>' },
    })
    expect(wrapper.findAll('.split-panes__pane')).toHaveLength(2)
    expect(wrapper.findAll('.split-panes__divider')).toHaveLength(1)
    const panes = wrapper.findAll('.split-panes__pane')
    expect(panes[0].attributes('style')).toContain('flex-basis: 30%')
    expect(panes[1].attributes('style')).toContain('flex-basis: 70%')
    expect(wrapper.find('.a').text()).toBe('A')
  })

  it('storageKey 恢复持久化占比；损坏 JSON / 长度不符回退 initial', () => {
    localStorage.setItem('splitpanes:inbox', JSON.stringify([22, 78]))
    const restored = mount(SplitPanes, { props: { initial: [50, 50], storageKey: 'inbox' } })
    expect(restored.find('.split-panes__pane').attributes('style')).toContain('flex-basis: 22%')

    localStorage.setItem('splitpanes:broken', '{not json')
    const broken = mount(SplitPanes, { props: { initial: [40, 60], storageKey: 'broken' } })
    expect(broken.find('.split-panes__pane').attributes('style')).toContain('flex-basis: 40%')

    localStorage.setItem('splitpanes:badlen', JSON.stringify([10, 20, 70]))
    const badLen = mount(SplitPanes, { props: { initial: [40, 60], storageKey: 'badlen' } })
    expect(badLen.find('.split-panes__pane').attributes('style')).toContain('flex-basis: 40%')
  })
})

describe('SplitPanes 拖拽', () => {
  it('非受控：拖拽换算位移并更新占比，松开后写入 localStorage', async () => {
    const wrapper = mount(SplitPanes, {
      props: { initial: [50, 50], storageKey: 'drag' },
      slots: { 'pane-0': 'A', 'pane-1': 'B' },
    })
    // 容器 1000px：clientX=400 → 40%，divider 中点 25% → delta=+15 → [65, 35]
    await dragDivider(wrapper, 400)
    expect(wrapper.find('.split-panes__pane').attributes('style')).toContain('flex-basis: 65%')
    expect(JSON.parse(localStorage.getItem('splitpanes:drag') ?? '[]')).toEqual([
      expect.closeTo(65, 5),
      expect.closeTo(35, 5),
    ])
  })

  it('min 夹取：左侧不低于 min，右侧补足（先触一侧优先）', async () => {
    const wrapper = mount(SplitPanes, {
      props: { initial: [50, 50], min: [30, 30] },
      slots: { 'pane-0': 'A', 'pane-1': 'B' },
    })
    // clientX=10 → 1% → a=26 < 30 → a=30, b=70
    await dragDivider(wrapper, 10)
    expect(wrapper.find('.split-panes__pane').attributes('style')).toContain('flex-basis: 30%')
  })

  it('受控模式：不直接改 innerSizes，emit update:sizes', async () => {
    const wrapper = mount(SplitPanes, {
      props: { sizes: [50, 50], initial: [50, 50] },
      slots: { 'pane-0': 'A', 'pane-1': 'B' },
    })
    await dragDivider(wrapper, 400)
    expect(wrapper.find('.split-panes__pane').attributes('style')).toContain('flex-basis: 50%')
    const emitted = wrapper.emitted('update:sizes')
    expect(emitted).toHaveLength(1)
    expect(emitted?.[0]?.[0]).toEqual([expect.closeTo(65, 5), expect.closeTo(35, 5)])
  })

  it('双击分隔条：复位该对为 initial 并持久化', async () => {
    const wrapper = mount(SplitPanes, {
      props: { initial: [50, 50], storageKey: 'reset' },
      slots: { 'pane-0': 'A', 'pane-1': 'B' },
    })
    await dragDivider(wrapper, 400)
    expect(wrapper.find('.split-panes__pane').attributes('style')).toContain('flex-basis: 65%')

    await wrapper.find('.split-panes__divider').trigger('dblclick')
    expect(wrapper.find('.split-panes__pane').attributes('style')).toContain('flex-basis: 50%')
    expect(JSON.parse(localStorage.getItem('splitpanes:reset') ?? '[]')).toEqual([
      expect.closeTo(50, 5),
      expect.closeTo(50, 5),
    ])
  })
})
