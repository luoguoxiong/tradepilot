import type { Directive, DirectiveBinding } from 'vue'

import { useAuthStore } from '@/stores/auth'

/**
 * v-permission 元素级裁剪（05 §3.1）：
 * - v-permission="['admin','manager']" → 无权限移除元素（display 隐藏）
 * - v-permission.disabled="['admin']"  → 保留元素但禁用（置灰 + 不可点）
 */
interface PermissionEl extends HTMLElement {
  __tpPermDisplay__?: string
}

function evaluate(el: PermissionEl, binding: DirectiveBinding<string[]>) {
  const auth = useAuthStore()
  const roles = binding.value ?? []
  const allowed = roles.length === 0 || (auth.user ? roles.includes(auth.user.role) : false)

  if (allowed) {
    if (el.__tpPermDisplay__ !== undefined) {
      el.style.display = el.__tpPermDisplay__
      delete el.__tpPermDisplay__
    }
    el.removeAttribute('disabled')
    el.removeAttribute('aria-disabled')
    return
  }

  if (binding.modifiers.disabled) {
    el.setAttribute('disabled', 'disabled')
    el.setAttribute('aria-disabled', 'true')
    el.style.pointerEvents = 'none'
    el.style.opacity = '0.5'
    return
  }

  if (el.__tpPermDisplay__ === undefined) {
    el.__tpPermDisplay__ = el.style.display
    el.style.display = 'none'
  }
}

export const vPermission: Directive<PermissionEl, string[]> = {
  mounted: evaluate,
  updated: evaluate,
}
