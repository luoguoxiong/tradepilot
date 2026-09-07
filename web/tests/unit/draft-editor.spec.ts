import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

import DraftEditor from '@/features/inbox/components/DraftEditor.vue'

/**
 * DraftEditor 单测（M5-B3 / 06 §2 中栏 composer）：
 * - 纯文本模型：\n\n 分段 ↔ 段落互转，字数统计随外部回填刷新；
 * - 安全：外部文本回填一律 DOMPurify 无标签消毒（script/HTML 剥离，纯文本口径）；
 * - expose insertText（Copilot「插入草稿」扩展点）→ onUpdate 回吐 \n\n 分段纯文本；
 * - readonly：工具条禁用。
 */
const ORIGINAL = 'Hi Anna,\n\nPlease find our spring collection price list attached.'

/** Tiptap v3 useEditor 异步建实例：挂载后 flush 一轮再断言 DOM */
const mounted: VueWrapper[] = []

async function mountEditor(props: { modelValue: string } & Record<string, unknown>) {
  const wrapper = mount(DraftEditor, { props })
  mounted.push(wrapper)
  await flushPromises()
  await nextTick()
  return wrapper
}

describe('DraftEditor', () => {
  // Tiptap 编辑器持有挂起任务：统一卸载防测试环境拆除后报悬挂定时器
  afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount()
  })
  it('初始内容渲染为多段落 + 字数统计', async () => {
    const wrapper = await mountEditor({ modelValue: ORIGINAL })
    const body = wrapper.find('[data-testid="draft-editor"]')
    expect(body.text()).toContain('Hi Anna,')
    expect(body.text()).toContain('Please find our spring collection price list attached.')
    expect(body.element.querySelectorAll('p')).toHaveLength(2)
    expect(wrapper.find('.draft-editor__count').text()).toBe(String(ORIGINAL.length))
  })

  it('安全：回填内容含 script/HTML 时一律剥离标签（纯文本口径）', async () => {
    const wrapper = await mountEditor({
      modelValue: '<script>alert(1)</script>Hello <b>world</b><img src=x onerror=alert(2)>',
    })
    const body = wrapper.find('[data-testid="draft-editor"]')
    expect(body.text()).toContain('Hello world')
    expect(body.text()).not.toContain('alert(1)')
    expect(body.element.querySelector('img')).toBeNull()
    expect(body.element.querySelector('b')).toBeNull()
  })

  it('外部 modelValue 变化整体替换编辑器内容（生成/重新生成回填）', async () => {
    const wrapper = await mountEditor({ modelValue: ORIGINAL })
    const updated = 'Updated draft body'
    await wrapper.setProps({ modelValue: updated })
    await nextTick()
    expect(wrapper.find('[data-testid="draft-editor"]').text()).toContain('Updated draft body')
    expect(wrapper.find('.draft-editor__count').text()).toBe(String(updated.length))
  })

  it('expose insertText：插入要点触发 update:modelValue（\\n\\n 分段纯文本）', async () => {
    const wrapper = await mountEditor({ modelValue: '' })
    ;(wrapper.vm as unknown as { insertText: (text: string) => void }).insertText(
      'Line one\n\nLine two',
    )
    await nextTick()
    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted).toHaveLength(1)
    expect(emitted?.[0]?.[0]).toBe('Line one\n\nLine two')
  })

  it('readonly：工具条按钮禁用', async () => {
    const wrapper = await mountEditor({ modelValue: ORIGINAL, readonly: true })
    for (const btn of wrapper.findAll('.draft-editor__btn')) {
      expect(btn.attributes('disabled')).toBeDefined()
    }
  })
})
