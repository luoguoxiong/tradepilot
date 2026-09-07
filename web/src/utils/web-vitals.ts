import { onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals'

/**
 * Web Vitals 实测上报（技术方案 05 §5 / 06 §1）：
 * - 仅生产构建启用（dev/测试不注入，控制台日志生产禁用）；
 * - LCP/INP/CLS + TTFB/FCP，sendBeacon 上报 /telemetry/web-vitals（staging 实测作 06 §1 指标回归依据）；
 * - 上报失败静默（观测数据不阻塞业务）。
 */

interface VitalPayload {
  name: string
  value: number
  rating: string
  id: string
  path: string
  ts: number
}

const ENDPOINT = '/api/v1/telemetry/web-vitals'

function report(payload: VitalPayload): void {
  if (typeof navigator.sendBeacon === 'function') {
    navigator.sendBeacon(ENDPOINT, JSON.stringify(payload))
    return
  }
  void fetch(ENDPOINT, {
    method: 'POST',
    body: JSON.stringify(payload),
    keepalive: true,
    headers: { 'content-type': 'application/json' },
  }).catch(() => {})
}

export function initWebVitals(): void {
  if (!import.meta.env.PROD) return
  const path = `${location.pathname}${location.search}`
  const handlers = [onCLS, onFCP, onINP, onLCP, onTTFB]
  for (const on of handlers) {
    on((metric) => {
      report({
        name: metric.name,
        value: metric.value,
        rating: metric.rating,
        id: metric.id,
        path,
        ts: Date.now(),
      })
    })
  }
}
