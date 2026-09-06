import { defineStore } from 'pinia'

import { i18n } from '@/locales'
import { ENUMS, type EnumGroup, type EnumOption } from '@/utils/enum-map'

/**
 * dictStore 全局枚举映射（03 §2/§7）。
 * MVP 枚举为稳定契约（接口规范 §2/§3），静态注册即可，不依赖服务端字典接口；
 * 后续出现服务端字典时在此扩展 loader（staleTime 10min，见 query/client 契约）。
 */
export const useDictStore = defineStore('dict', {
  state: () => ({}),

  getters: {
    options(): (group: EnumGroup) => readonly EnumOption[] {
      return (group: EnumGroup) => ENUMS[group]
    },
  },

  actions: {
    /** 枚举值 → 本地化文案；未知值原样返回（容错脏数据） */
    label(group: EnumGroup, value: string | undefined | null): string {
      if (!value) return '—'
      const option = (ENUMS[group] as readonly EnumOption[]).find((o) => o.value === value)
      return option ? i18n.global.t(option.labelKey) : value
    },

    /** 枚举值 → Design Tokens 语义色（AiStatusTag / 状态列共用） */
    color(group: EnumGroup, value: string | undefined | null): string | undefined {
      const option = (ENUMS[group] as readonly EnumOption[]).find((o) => o.value === value)
      return option?.color
    },
  },
})
