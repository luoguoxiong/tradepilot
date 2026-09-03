/**
 * 产品档案全局状态：档案列表 + 当前档案（id 持久化到 localStorage）
 */
import { defineStore } from 'pinia'
import { api, normalizeList, type Profile } from '../api/client'

const STORAGE_KEY = 'tradepilot.currentProfileId'

/** 从 localStorage 读取上次选中的档案 id */
function loadSavedId(): number | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

export const useProfileStore = defineStore('profile', {
  state: () => ({
    profiles: [] as Profile[],
    currentId: loadSavedId()
  }),
  getters: {
    /** 当前档案（currentId 失效时回退到第一个） */
    current(state): Profile | null {
      return state.profiles.find((p) => p.id === state.currentId) ?? state.profiles[0] ?? null
    }
  },
  actions: {
    /** 拉取档案列表；已加载且非强制时直接复用缓存 */
    async fetch(force = false): Promise<void> {
      if (!force && this.profiles.length) return
      this.profiles = normalizeList<Profile>(await api.listProfiles())
      // 当前 id 不在列表中（被删除/首次使用）时，自动选中第一个并持久化
      if (this.profiles.length && !this.profiles.some((p) => p.id === this.currentId)) {
        this.setCurrent(this.profiles[0].id)
      }
    },
    /** 切换当前档案并写入 localStorage */
    setCurrent(id: number): void {
      this.currentId = id
      localStorage.setItem(STORAGE_KEY, String(id))
    }
  }
})
