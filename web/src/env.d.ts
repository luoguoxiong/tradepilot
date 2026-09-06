/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 接口基路径（默认 /api/v1 同域反代） */
  readonly VITE_API_BASE: string
  /** 开发代理目标网关 */
  readonly VITE_PROXY_TARGET?: string
  /** MSW Mock 开关（06 §5.3） */
  readonly VITE_USE_MOCK?: string
  /** 特性档位 p0 | p1（AD-4） */
  readonly VITE_FEATURES_PROFILE?: 'p0' | 'p1'
  /** Sentry DSN（05 §5） */
  readonly VITE_SENTRY_DSN?: string
  /** git sha，sourcemap 关联与灰度排查 */
  readonly VITE_RELEASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
