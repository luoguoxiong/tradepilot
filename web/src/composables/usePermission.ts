import { computed } from 'vue'

import type { Role } from '@/api/types/common'
import { useAuthStore } from '@/stores/auth'

/**
 * usePermission 逻辑级裁剪（05 §3.1 第三层）：复杂场景组合判断。
 * 基线映射见 05 §3.2；与接口约束不一致时以服务端 40301 为准。
 */
export function usePermission() {
  const auth = useAuthStore()

  const role = computed<Role | undefined>(() => auth.user?.role)

  function hasRole(roles: Role[]): boolean {
    return role.value ? roles.includes(role.value) : false
  }

  /** 管理类操作（员工账号/审批/改派/知识删除等基线，05 §3.2） */
  const canManage = computed(() => hasRole(['admin', 'manager']))

  const isAdmin = computed(() => role.value === 'admin')

  /** 数据范围上限（05 §2）：sales 固定 self；manager team；admin all */
  const maxScope = computed<'self' | 'team' | 'all'>(() => {
    if (role.value === 'admin') return 'all'
    if (role.value === 'manager') return 'team'
    return 'self'
  })

  return { role, hasRole, canManage, isAdmin, maxScope }
}
