import skipFormatting from '@vue/eslint-config-prettier/skip-formatting'
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'
import pluginVue from 'eslint-plugin-vue'

export default defineConfigWithVueTs(
  {
    name: 'app/files-to-lint',
    files: ['**/*.{ts,mts,tsx,vue}'],
  },
  {
    name: 'app/files-to-ignore',
    ignores: [
      '**/dist/**',
      '**/dist-ssr/**',
      '**/coverage/**',
      'auto-imports.d.ts',
      'components.d.ts',
      'public/mockServiceWorker.js',
    ],
  },
  pluginVue.configs['flat/essential'],
  vueTsConfigs.recommended,
  skipFormatting,
  {
    name: 'app/custom-rules',
    rules: {
      // 组件统一多词 PascalCase；视图页（View）除外
      'vue/multi-word-component-names': 'off',
      // AI/邮件富文本禁裸 v-html，一律 DOMPurify 消毒后渲染（05 §4.1）
      'vue/no-v-html': 'error',
      // TS strict：禁 any（第三方缺类型才允许局部 unknown 收窄，01 §3）
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'inline-type-imports' },
      ],
    },
  },
)
