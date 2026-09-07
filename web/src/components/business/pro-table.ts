import type { EnumGroup } from '@/utils/enum-map'

/** ProTable 列 schema（02 §4.1）——独立类型文件（script setup 泛型组件内不允许 export） */
export interface ProColumn {
  prop: string
  /** i18n 列头 key */
  labelKey: string
  width?: number | string
  minWidth?: number | string
  /** custom = 服务端排序（sortBy/sortOrder 上行） */
  sortable?: boolean | 'custom'
  fixed?: 'left' | 'right'
  align?: 'left' | 'center' | 'right'
  /** 枚举列：dictStore 自动渲染（label + 语义色） */
  enumGroup?: EnumGroup
}
