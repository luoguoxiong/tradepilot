import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { effectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sseResponse } from '@/mocks/sse'
import { useTaskStream } from '@/sse/useTaskStream'

/**
 * useTaskStream 单测（排期 M3-3 / 03 §6.2）：
 * ① SSE 正常链路：基线续传 + log 去重排序 + done 终态收流；
 * ② 降级演练：SSE 持续失败 → 指数退避耗尽 → 轮询 /logs + /tasks/{id} 接管至终态。
 * jsdom 页面 origin 为 localhost:3000，处理器用端口通配 `localhost:*`。
 */

interface LogRow {
  logId: string
  time: string
  type: string
  content: string
}

function log(id: string, content: string): LogRow {
  return { logId: id, time: '2026-09-06T10:00:00Z', type: 'search', content }
}

function logsResp(items: LogRow[]) {
  return HttpResponse.json({ code: 0, message: 'ok', data: { items, hasMore: false } })
}

async function until(cond: () => boolean, timeout = 3000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('condition timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('useTaskStream', () => {
  let pollDetailCalls = 0
  const server = setupServer()
  let originalFetch: typeof fetch

  beforeEach(() => {
    pollDetailCalls = 0
    server.listen({ onUnhandledRequest: 'error' })
    // fetch-event-source 使用相对 URL（jsdom/undici 不解析）：包装为绝对地址后再交给 MSW。
    // 必须在 server.listen 之后取 fetch（MSW 已替换 global fetch，包装链保持拦截生效）。
    originalFetch = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' && input.startsWith('/')
          ? new URL(input, window.location.origin)
          : input
      return originalFetch(url, init)
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    server.resetHandlers()
    server.close()
    vi.restoreAllMocks()
  })

  it('SSE 正常链路：基线续传 + 去重 + done 收流', async () => {
    server.use(
      http.get('/api/v1/tasks/task-1/logs', ({ request }) => {
        const after = new URL(request.url).searchParams.get('after') ?? ''
        const all = [log('log-1', '基线日志')]
        return logsResp(after ? all.filter((l) => l.logId > after) : all)
      }),
      http.get('/api/v1/tasks/task-1', () =>
        HttpResponse.json({
          code: 0,
          message: 'ok',
          data: {
            taskId: 'task-1',
            title: '寻找美国跑鞋品牌',
            type: 'lead_hunting',
            status: 'running',
            progressPct: 10,
            currentStep: '搜索潜在公司',
          },
        }),
      ),
      http.get('/api/v1/tasks/task-1/stream', () =>
        sseResponse(
          [
            { event: 'log', data: log('log-1', '基线重放（应被去重）') },
            { event: 'log', data: log('log-2', '发现公司 ABC Sports') },
            { event: 'progress', data: { progressPct: 60, currentStep: '分析公司官网' } },
            { event: 'log', data: log('log-10', '产品匹配度 92%') },
            {
              event: 'done',
              data: { status: 'completed', outputs: [{ type: 'leads', payload: [] }] },
            },
          ],
          10,
        ),
      ),
    )

    const onDone = vi.fn()
    const scope = effectScope()
    const stream = scope.run(() =>
      useTaskStream('task-1', { retryBaseMs: 10, retryMaxMs: 20, maxRetries: 2, onDone }),
    )!
    await stream.start()
    await until(() => stream.state.source === 'done')

    expect(stream.state.logs.map((l) => l.logId)).toEqual(['log-1', 'log-2', 'log-10'])
    expect(stream.state.progressPct).toBe(60)
    expect(stream.state.currentStep).toBe('分析公司官网')
    expect(stream.state.status).toBe('completed')
    expect(stream.state.source).toBe('done')
    expect(stream.state.outputs).toEqual([{ type: 'leads', payload: [] }])
    expect(onDone).toHaveBeenCalledWith('completed')
    scope.stop()
  })

  it('SSE 持续失败 → 降级轮询接管至终态', async () => {
    server.use(
      http.get('/api/v1/tasks/task-1/stream', () =>
        HttpResponse.json({ message: 'boom' }, { status: 500 }),
      ),
      http.get('/api/v1/tasks/task-1/logs', ({ request }) => {
        const after = new URL(request.url).searchParams.get('after') ?? ''
        const all = [log('log-1', '基线日志'), log('log-2', '轮询补拉日志')]
        return logsResp(after ? all.filter((l) => l.logId > after) : all)
      }),
      // 首次（基线）running；轮询第 2 次起 completed
      http.get('/api/v1/tasks/task-1', () => {
        pollDetailCalls += 1
        const done = pollDetailCalls >= 2
        return HttpResponse.json({
          code: 0,
          message: 'ok',
          data: {
            taskId: 'task-1',
            title: '寻找美国跑鞋品牌',
            type: 'lead_hunting',
            status: done ? 'completed' : 'running',
            progressPct: done ? 100 : 50,
            outputs: done ? [{ type: 'leads', payload: ['lead-1'] }] : null,
          },
        })
      }),
    )

    const onDone = vi.fn()
    const scope = effectScope()
    const stream = scope.run(() =>
      useTaskStream('task-1', {
        retryBaseMs: 10,
        retryMaxMs: 20,
        maxRetries: 2,
        pollIntervalMs: 10,
        onDone,
      }),
    )!
    await stream.start()
    await until(() => stream.state.source === 'done')

    expect(stream.state.source).toBe('done')
    expect(stream.state.logs.map((l) => l.logId)).toEqual(['log-1', 'log-2'])
    expect(stream.state.status).toBe('completed')
    expect(stream.state.outputs).toEqual([{ type: 'leads', payload: ['lead-1'] }])
    expect(onDone).toHaveBeenCalledWith('completed')
    scope.stop()
  })
})
