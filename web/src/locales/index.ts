import { createI18n } from 'vue-i18n'

import en from './en'
import zhCN from './zh-CN'

export type Lang = 'zh-CN' | 'en'
export const LOCALE_STORAGE_KEY = 'tradepilot.locale'

const LOCALES = { 'zh-CN': zhCN, en } as const

function readInitialLocale(): Lang {
  const saved = localStorage.getItem(LOCALE_STORAGE_KEY)
  if (saved && saved in LOCALES) return saved as Lang
  // 默认语言兜底 zh-CN（01 §6）；org.defaultLanguage 联动在 M2 接入 authStore 后处理
  return 'zh-CN'
}

export const i18n = createI18n({
  legacy: false,
  locale: readInitialLocale(),
  fallbackLocale: 'zh-CN',
  messages: LOCALES,
})

export function persistLocale(lang: Lang) {
  localStorage.setItem(LOCALE_STORAGE_KEY, lang)
}
