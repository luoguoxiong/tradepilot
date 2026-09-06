import type { FeatureKey } from '@/features'
import type { Role } from '@/api/types/common'

import 'vue-router'

declare module 'vue-router' {
  interface RouteMeta {
    /** i18n key（locales/menu.* 或 auth.*），用于菜单文案与 document.title */
    title?: string
    /** Element Plus 图标组件名（GlobalSider iconMap） */
    icon?: string
    /** 是否进入 Sider 菜单（02 §1.1：菜单由路由表自动生成） */
    menu?: boolean
    /** 菜单排序 */
    order?: number
    /** 角色裁剪（UX 层，服务端 40301 为权威） */
    roles?: Role[]
    /** 特性开关（features.ts，p0 profile 构建期剔除） */
    feature?: FeatureKey
    /** 免认证路由（登录/注册） */
    public?: boolean
    /** 错误页类型 */
    errorType?: '403' | '404'
  }
}

export {}
