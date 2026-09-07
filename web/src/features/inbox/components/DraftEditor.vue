<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useEditor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import DOMPurify from 'dompurify'

/**
 * DraftEditor 邮件草稿编辑器（06 §2 中栏 composer / M5-3）：
 * - Tiptap StarterKit 精简工具栏（加粗/斜体/列表/引用）+ 字数统计；
 * - 对外模型为纯文本（\n\n 分段），内部转段落 HTML，保证与 mock/契约纯文本口径一致；
 * - 外部文本回填一律 DOMPurify 无标签消毒（纯文本口径，杜绝 HTML 注入）；
 * - 暴露 focus/insertText 供 Copilot「插入草稿」等外部操作。
 */
const props = withDefaults(
  defineProps<{
    modelValue: string
    placeholder?: string
    /** 只读态（waiting_approval 等） */
    readonly?: boolean
    minHeight?: number
  }>(),
  { placeholder: '', readonly: false, minHeight: 140 },
)

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

/** 纯文本 → 段落 HTML（外部 insertDraft / 回填草稿） */
function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(
      (p) =>
        `<p>${DOMPurify.sanitize(p.trim(), { ALLOWED_TAGS: [], ALLOWED_ATTR: [] }).replace(/\n/g, '<br>')}</p>`,
    )
    .join('')
}

const editor = useEditor({
  content: textToHtml(props.modelValue),
  editable: !props.readonly,
  editorProps: {
    attributes: {
      class: 'draft-editor__content',
      'data-testid': 'draft-editor',
      'aria-label': 'draft editor',
    },
  },
  extensions: [
    StarterKit.configure({
      // 精简至邮件常用 marks/blocks（v3：false 关闭，默认启用项省略）
      heading: false,
      codeBlock: false,
      horizontalRule: false,
    }),
  ],
  onUpdate: ({ editor: instance }) => {
    emit('update:modelValue', instance.getText({ blockSeparator: '\n\n' }))
  },
})

/** 外部内容变化（生成/重新生成/插入要点）→ 整体替换（编辑差异由服务端 PUT 沉淀） */
watch(
  () => props.modelValue,
  (value) => {
    if (!editor.value) return
    const current = editor.value.getText({ blockSeparator: '\n\n' })
    if (value !== current)
      editor.value.commands.setContent(textToHtml(value), { emitUpdate: false })
  },
)

watch(
  () => props.readonly,
  (value) => editor.value?.setEditable(!value),
)

const charCount = ref(0)
watch(
  () => props.modelValue,
  (value) => {
    charCount.value = value.length
  },
  { immediate: true },
)

function focus(): void {
  editor.value?.commands.focus()
}

/** 在光标处插入文本（Copilot 引用插入等扩展点） */
function insertText(text: string): void {
  editor.value?.commands.insertContent(textToHtml(text))
}

defineExpose({ focus, insertText })

onBeforeUnmount(() => editor.value?.destroy())
</script>

<template>
  <div class="draft-editor">
    <div class="draft-editor__toolbar">
      <button
        type="button"
        class="draft-editor__btn"
        :class="{ 'is-active': editor?.isActive('bold') }"
        :disabled="readonly"
        title="Bold"
        @click="editor?.chain().focus().toggleBold().run()"
      >
        B
      </button>
      <button
        type="button"
        class="draft-editor__btn draft-editor__btn--italic"
        :class="{ 'is-active': editor?.isActive('italic') }"
        :disabled="readonly"
        title="Italic"
        @click="editor?.chain().focus().toggleItalic().run()"
      >
        I
      </button>
      <button
        type="button"
        class="draft-editor__btn"
        :class="{ 'is-active': editor?.isActive('bulletList') }"
        :disabled="readonly"
        title="Bullet list"
        @click="editor?.chain().focus().toggleBulletList().run()"
      >
        • ≡
      </button>
      <button
        type="button"
        class="draft-editor__btn"
        :class="{ 'is-active': editor?.isActive('orderedList') }"
        :disabled="readonly"
        title="Ordered list"
        @click="editor?.chain().focus().toggleOrderedList().run()"
      >
        1. ≡
      </button>
      <button
        type="button"
        class="draft-editor__btn"
        :class="{ 'is-active': editor?.isActive('blockquote') }"
        :disabled="readonly"
        title="Quote"
        @click="editor?.chain().focus().toggleBlockquote().run()"
      >
        ❝
      </button>
      <span class="draft-editor__count">{{ charCount }}</span>
    </div>
    <EditorContent
      :editor="editor"
      class="draft-editor__body"
      :style="{ minHeight: `${minHeight}px` }"
    />
  </div>
</template>

<style scoped lang="scss">
.draft-editor {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background: var(--el-bg-color);
  overflow: hidden;

  &:focus-within {
    border-color: var(--el-color-primary);
  }

  &__toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--el-border-color-lighter);
    background: var(--el-fill-color-light);
  }

  &__btn {
    min-width: 26px;
    padding: 2px 6px;
    border: none;
    border-radius: 4px;
    background: transparent;
    font-size: 12px;
    color: var(--el-text-color-regular);
    cursor: pointer;

    &:hover:not(:disabled) {
      background: var(--el-fill-color);
    }

    &.is-active {
      background: var(--el-color-primary-light-8);
      color: var(--el-color-primary);
    }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }

    &--italic {
      font-style: italic;
    }
  }

  &__count {
    margin-left: auto;
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }

  &__body {
    :deep(.draft-editor__content) {
      max-height: 260px;
      padding: 10px 12px;
      overflow-y: auto;
      outline: none;
      font-size: 14px;
      line-height: 1.7;

      p {
        margin: 0 0 10px;
      }

      &:empty::before {
        color: var(--el-text-color-placeholder);
        content: attr(aria-label);
      }
    }
  }
}
</style>
