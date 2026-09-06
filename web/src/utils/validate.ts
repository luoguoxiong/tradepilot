const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** 邮箱校验（16 FR-01） */
export function isEmail(value: string | undefined | null): boolean {
  return EMAIL_RE.test(value ?? '')
}

/** 密码 ≥ 8 位（16 v0.4 登录决议） */
export function isPasswordValid(value: string | undefined | null): boolean {
  return (value?.length ?? 0) >= 8
}
