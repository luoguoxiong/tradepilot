import { defineStore } from 'pinia'

import { LOCALE_STORAGE_KEY, persistLocale, type Lang } from '@/locales'
import { setDayjsLocale } from '@/utils/date'

const SIDER_KEY = 'tradepilot.siderCollapsed'

interface AppState {
  siderCollapsed: boolean
  locale: Lang
}

function readLocale(): Lang {
  const saved = localStorage.getItem(LOCALE_STORAGE_KEY)
  return saved === 'en' ? 'en' : 'zh-CN'
}

export const useAppStore = defineStore('app', {
  state: (): AppState => ({
    siderCollapsed: localStorage.getItem(SIDER_KEY) === 'true',
    locale: readLocale(),
  }),

  actions: {
    toggleSider() {
      this.siderCollapsed = !this.siderCollapsed
      localStorage.setItem(SIDER_KEY, String(this.siderCollapsed))
    },

    setLocale(lang: Lang) {
      this.locale = lang
      persistLocale(lang)
      // dayjs 相对时间 locale 跟随界面语言（01 §6）
      setDayjsLocale(lang)
    },
  },
})
